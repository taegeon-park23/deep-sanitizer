// src/sanitizer.ts
import * as vscode from "vscode";
import * as path from "path";

const { Parser, Language, Query } = require("web-tree-sitter");

// [전략] 마스킹하지 말아야 할 일반적인 예약어 및 라이브러리 (Context 유지)
const RESERVED_NAMES = new Set([
  "console",
  "window",
  "document",
  "process",
  "global",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Date",
  "Promise",
  "Error",
  "React",
  "useState",
  "useEffect",
  "useCallback",
  "useMemo",
  "useRef",
  "useContext",
  "module",
  "exports",
  "require",
  "import",
  "export",
  "from",
  "as",
  "any",
  "string",
  "number",
  "boolean",
  "void",
  "null",
  "undefined",
  "never",
  "unknown",
]);

const QUERIES: Record<string, string> = {
  // Python 정의
  python: `
        (function_definition name: (identifier) @def.func)
        (class_definition name: (identifier) @def.class)
        (parameter (identifier) @def.var)
        (assignment left: (identifier) @def.var)
    `,
  // TypeScript/TSX
  typescript: `
        ; 1. 함수/메서드
        (function_declaration name: (identifier) @def.func)
        (method_definition name: (property_identifier) @def.func)
        
        ; 2. 클래스/인터페이스 (타입 정보)
        (class_declaration name: (type_identifier) @def.class)
        (interface_declaration name: (type_identifier) @def.type)
        (type_alias_declaration name: (type_identifier) @def.type)
        (enum_declaration name: (identifier) @def.type)
        
        ; 3. 변수 (속성명은 문맥 유지를 위해 제외하거나 신중히 처리)
        (variable_declarator name: (identifier) @def.var)
        
        ; 4. 파라미터
        (required_parameter (identifier) @def.var)
        (optional_parameter (identifier) @def.var)
    `,
};

// React 및 JS 지원
QUERIES["typescriptreact"] = QUERIES["typescript"];
QUERIES["javascript"] = QUERIES["typescript"];
QUERIES["javascriptreact"] = QUERIES["typescript"];

export class AutoCodeSanitizer {
  private parser: any = null;
  private extensionPath: string;

  // 변환 테이블
  private mapForward = new Map<string, string>();
  private mapBackward = new Map<string, string>();
  private typeCounters: Record<string, number> = {};

  private _getWasmFile(languageId: string): string {
    if (languageId === "python") return "tree-sitter-python.wasm";
    if (languageId.includes("react")) return "tree-sitter-tsx.wasm";
    if (languageId.includes("typescript") || languageId.includes("javascript"))
      return "tree-sitter-typescript.wasm";
    return "";
  }

  constructor(extensionPath: string) {
    this.extensionPath = extensionPath;
  }

  public async init() {
    if (this.parser) return;
    try {
      const initFile = "web-tree-sitter.wasm";
      const initPath = path.join(this.extensionPath, "parsers", initFile);
      await Parser.init({ locateFile: () => initPath });
      this.parser = new Parser();
    } catch (e) {
      console.error(e);
      throw new Error(`Tree-sitter init failed: ${e}`);
    }
  }

  /**
   * [전략 2 & 3] 시맨틱(의미론적) 마스킹 생성
   * AI가 변수 타입과 역할을 유추할 수 있도록 힌트를 주는 접두어 사용
   */
  private getReplacement(originalName: string, typeTag: string): string {
    if (this.mapForward.has(originalName))
      return this.mapForward.get(originalName)!;

    // 1. 기본 카테고리
    let prefix = "VAR";
    if (typeTag.includes("func")) prefix = "ACTION";
    else if (typeTag.includes("class")) prefix = "CLASS";
    else if (typeTag.includes("type")) prefix = "TYPE";

    // 2. [개선] 헝가리안 표기법 스타일의 힌트 추가 (AI 이해도 향상)
    // 리스트/배열
    if (
      originalName.match(/(List|Array|Items|Collection|s)$/) &&
      !originalName.endsWith("ss")
    ) {
      prefix = "LIST_" + prefix;
    }
    // 불리언 (Is, Has, Can)
    else if (originalName.match(/^(is|has|can|should|did|will)[A-Z]/)) {
      prefix = "BOOL";
    }
    // 문자열 관련 (Name, Title, Text, Str)
    else if (
      originalName.match(/(Name|Title|Text|String|Str|Label|Message|Msg)$/)
    ) {
      prefix = "STR";
    }
    // 숫자 관련 (Count, Idx, Num, Size, Length)
    else if (
      originalName.match(
        /(Count|Index|Idx|Num|Size|Length|Amount|Price|Total)$/,
      )
    ) {
      prefix = "NUM";
    }
    // ID/Key
    else if (originalName.match(/(Id|Key|Code|Uuid)$/)) {
      prefix = "ID";
    }
    // 핸들러
    else if (originalName.match(/^(on|handle)[A-Z]/)) {
      prefix = "HANDLER";
    }
    // React Hooks
    else if (originalName.startsWith("use") && originalName.length > 3) {
      prefix = "HOOK";
    }
    // Props
    else if (originalName.endsWith("Props") || originalName === "props") {
      prefix = "PROPS";
    }

    const key = prefix.toLowerCase();
    if (!this.typeCounters[key]) this.typeCounters[key] = 0;
    this.typeCounters[key]++;

    // 예: STR_1, BOOL_5, ACTION_user_3 (가능하다면)
    // 여기서는 단순하게 접두어_숫자로 처리
    const maskedName = `${prefix}_${this.typeCounters[key]}`;

    this.mapForward.set(originalName, maskedName);
    this.mapBackward.set(maskedName, originalName);
    return maskedName;
  }

  public async sanitize(
    code: string,
    langId: string,
    options: { maskVars: boolean; maskFuncs: boolean; maskClasses: boolean },
  ): Promise<{ sanitized: string; mapping: any }> {
    if (!this.parser) await this.init();

    // 초기화
    this.mapForward.clear();
    this.mapBackward.clear();
    this.typeCounters = {};

    const wasmFile = this._getWasmFile(langId);
    if (!wasmFile) return { sanitized: code, mapping: {} };

    const wasmPath = path.join(this.extensionPath, "parsers", wasmFile);

    let tree: any = null;
    let defQuery: any = null;
    let replaceQuery: any = null;

    try {
      const languageObj = await Language.load(wasmPath);
      this.parser.setLanguage(languageObj);
      tree = this.parser.parse(code);

      // 1. 정의(Definition) 수집
      let queryKey = langId;
      if (langId.includes("react") || langId === "javascript")
        queryKey = "typescript";

      const defQueryStr = QUERIES[queryKey];
      if (defQueryStr) {
        defQuery = new Query(this.parser.language, defQueryStr);
        const matches = defQuery.matches(tree.rootNode);

        for (const match of matches) {
          for (const capture of match.captures) {
            const nodeText = capture.node.text;
            const tag = capture.name;

            // 옵션 및 예외 처리 검사
            if (tag.includes("var") && !options.maskVars) continue;
            if (tag.includes("func") && !options.maskFuncs) continue;
            if (
              (tag.includes("class") || tag.includes("type")) &&
              !options.maskClasses
            )
              continue;

            // [안전장치] 너무 짧거나, 이미 예약된어이거나, 표준 라이브러리인 경우 건너뜀
            if (nodeText.length < 2) continue;
            if (nodeText.startsWith("_")) continue;
            if (RESERVED_NAMES.has(nodeText)) continue;

            if (!this.mapForward.has(nodeText)) {
              this.getReplacement(nodeText, tag);
            }
          }
        }
      }

      // 2. 전체 코드 치환 (Text Replacement using Tree-sitter ranges)
      replaceQuery = new Query(
        this.parser.language,
        `
          (identifier) @ident
          (type_identifier) @ident
          (property_identifier) @ident
          (shorthand_property_identifier_pattern) @ident
        `,
      );

      const captures = replaceQuery.captures(tree.rootNode);
      // 인덱스가 꼬이지 않도록 뒤에서부터 교체
      captures.sort((a: any, b: any) => b.node.startIndex - a.node.startIndex);

      let resultText = code;

      for (const capture of captures) {
        const node = capture.node;
        const text = node.text;

        // mapForward에 존재하는 것만 교체 (정의 단계에서 필터링된 것은 여기서도 무시됨)
        if (this.mapForward.has(text)) {
          const masked = this.mapForward.get(text)!;
          resultText =
            resultText.substring(0, node.startIndex) +
            masked +
            resultText.substring(node.endIndex);
        }
      }

      return {
        sanitized: resultText,
        mapping: Object.fromEntries(this.mapBackward),
      };
    } catch (e) {
      console.error("Sanitization error", e);
      return { sanitized: code, mapping: {} };
    } finally {
      if (tree) tree.delete();
      if (defQuery) defQuery.delete();
      if (replaceQuery) replaceQuery.delete();
    }
  }

  /**
   * 내부 복호화 로직 (State-Safe)
   * AI가 생성한 신규 변수(매핑에 없는 키)는 건드리지 않고 그대로 둡니다.
   */
  private async _applyRestoration(
    code: string,
    languageId: string,
    mapTable: Map<string, string>,
  ): Promise<string> {
    const wasmFile =
      this._getWasmFile(languageId) || "tree-sitter-typescript.wasm";
    const wasmPath = path.join(this.extensionPath, "parsers", wasmFile);

    let tree: any = null;
    let query: any = null;

    try {
      await this.parser.setLanguage(await Language.load(wasmPath));
      tree = this.parser.parse(code);

      // 식별자만 찾아서 복구 시도
      query = new Query(
        this.parser.language,
        `
          (identifier) @ident
          (type_identifier) @ident
          (property_identifier) @ident
          (shorthand_property_identifier_pattern) @ident
        `,
      );

      const captures = query.captures(tree.rootNode);
      captures.sort((a: any, b: any) => b.node.startIndex - a.node.startIndex);

      let restoredCode = code;

      for (const capture of captures) {
        const node = capture.node;
        const text = node.text;

        // [핵심] 매핑 테이블에 있는 "암호화된 이름"만 원복
        if (mapTable.has(text)) {
          const original = mapTable.get(text)!;
          restoredCode =
            restoredCode.substring(0, node.startIndex) +
            original +
            restoredCode.substring(node.endIndex);
        }
        // 매핑에 없는(AI가 새로 만든) 변수는 변경 없음 -> 안전함
      }

      return restoredCode;
    } catch (e) {
      throw new Error(`Restoration failed: ${e}`);
    } finally {
      if (tree) tree.delete();
      if (query) query.delete();
    }
  }

  /**
   * [개선] 복호화 진입점
   * JSON 문자열 또는 객체/Map을 모두 지원하도록 오버로딩
   */
  public async restoreWithMap(
    code: string,
    mapping: string | Record<string, string> | Map<string, string>,
    langId: string,
  ): Promise<string> {
    if (!this.parser) await this.init();

    let restorationMap = new Map<string, string>();

    // 입력 타입에 따른 Map 변환
    if (typeof mapping === "string") {
      try {
        const parsed = JSON.parse(mapping);
        for (const [k, v] of Object.entries(parsed))
          restorationMap.set(k, v as string);
      } catch {
        throw new Error("Invalid JSON format for Map Table.");
      }
    } else if (mapping instanceof Map) {
      restorationMap = mapping;
    } else {
      // Object
      for (const [k, v] of Object.entries(mapping))
        restorationMap.set(k, v as string);
    }

    // 내부 상태 동기화 (선택 사항이나 디버깅 위해)
    this.mapBackward = restorationMap;

    return this._applyRestoration(code, langId, restorationMap);
  }

  // Legacy method support
  public async restore(code: string, langId: string): Promise<string> {
    return this.restoreWithMap(code, this.mapBackward, langId);
  }
}
