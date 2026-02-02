import * as vscode from "vscode";
import * as path from "path";

const { Parser, Language, Query } = require("web-tree-sitter");

// =============================================================================
// Constants & Configurations
// =============================================================================

/**
 * 마스킹하지 말아야 할 일반적인 예약어 및 라이브러리 목록.
 * 문맥 유지를 위해 보존합니다.
 */
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

export interface SanitizeOptions {
  maskVars: boolean;
  maskFuncs: boolean;
  maskClasses: boolean;
  maskStrings?: boolean;
  removeComments?: boolean;
  whitelist?: string[];
  whitelistMode?: "append" | "overwrite";
}

// =============================================================================
// AutoCodeSanitizer Class
// =============================================================================

/**
 * Tree-sitter를 사용하여 코드의 시맨틱 정보를 파악하고,
 * 지능적으로 식별자와 문자열을 마스킹/복호화하는 클래스입니다.
 */
export class AutoCodeSanitizer {
  private parser: any = null;
  private extensionPath: string;

  // 변환 테이블
  private mapForward = new Map<string, string>(); // Original -> Masked
  private mapBackward = new Map<string, string>(); // Masked -> Original
  private typeCounters: Record<string, number> = {};

  /**
   * 언어 ID에 맞는 WASM 파일명을 반환합니다.
   * @param languageId VS Code 언어 식별자
   */
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

  /**
   * Parser 및 WebAssembly 모듈을 비동기적으로 초기화합니다.
   * 최초 1회 실행됩니다.
   */
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
   * 원본 식별자 이름을 분석하여 의미있는 대체 이름(Masked Name)을 생성합니다.
   * 헝가리안 표기법 힌트를 사용하여 AI가 문맥을 이해하는 데 도움을 줍니다.
   * * @param originalName 원본 변수/함수명
   * @param typeTag Tree-sitter에서 추출한 타입 태그 (func, class, var 등)
   */
  private getReplacement(originalName: string, typeTag: string): string {
    if (this.mapForward.has(originalName))
      return this.mapForward.get(originalName)!;

    // 1. 기본 카테고리 결정
    let prefix = "VAR";
    if (typeTag.includes("func")) prefix = "ACTION";
    else if (typeTag.includes("class")) prefix = "CLASS";
    else if (typeTag.includes("type")) prefix = "TYPE";

    // 2. 이름 기반 힌트 추가 (Semantic Hinting)
    if (
      originalName.match(/(List|Array|Items|Collection|s)$/) &&
      !originalName.endsWith("ss")
    ) {
      prefix = "LIST_" + prefix;
    } else if (originalName.match(/^(is|has|can|should|did|will)[A-Z]/)) {
      prefix = "BOOL";
    } else if (
      originalName.match(/(Name|Title|Text|String|Str|Label|Message|Msg)$/)
    ) {
      prefix = "STR";
    } else if (
      originalName.match(
        /(Count|Index|Idx|Num|Size|Length|Amount|Price|Total)$/,
      )
    ) {
      prefix = "NUM";
    } else if (originalName.match(/(Id|Key|Code|Uuid)$/)) {
      prefix = "ID";
    } else if (originalName.match(/^(on|handle)[A-Z]/)) {
      prefix = "HANDLER";
    } else if (originalName.startsWith("use") && originalName.length > 3) {
      prefix = "HOOK";
    } else if (originalName.endsWith("Props") || originalName === "props") {
      prefix = "PROPS";
    }

    // 3. 고유 번호 부여
    const key = prefix.toLowerCase();
    if (!this.typeCounters[key]) this.typeCounters[key] = 0;
    this.typeCounters[key]++;

    const maskedName = `${prefix}_${this.typeCounters[key]}`;

    // 매핑 저장
    this.mapForward.set(originalName, maskedName);
    this.mapBackward.set(maskedName, originalName);
    return maskedName;
  }

  /**
   * 주어진 코드를 분석하여 민감한 정보를 마스킹(Sanitize)합니다.
   * 식별자(변수, 함수 등)와 문자열 리터럴을 처리합니다.
   * * @param code 원본 소스 코드
   * @param langId 언어 ID
   * @param options 마스킹 옵션
   * @returns 마스킹된 코드와 매핑 테이블
   */
  public async sanitize(
    code: string,
    langId: string,
    options: SanitizeOptions,
  ): Promise<{ sanitized: string; mapping: any }> {
    if (!this.parser) await this.init();

    // 매핑 상태 초기화
    this.mapForward.clear();
    this.mapBackward.clear();
    this.typeCounters = {};

    // 0. 화이트리스트(보존할 단어) 구성
    let activeReserved: Set<string>;
    if (options.whitelistMode === "overwrite") {
      activeReserved = new Set(options.whitelist || []);
    } else {
      activeReserved = new Set(RESERVED_NAMES);
      if (options.whitelist) {
        options.whitelist.forEach((word) => activeReserved.add(word));
      }
    }

    const wasmFile = this._getWasmFile(langId);
    if (!wasmFile) return { sanitized: code, mapping: {} };

    const wasmPath = path.join(this.extensionPath, "parsers", wasmFile);

    let tree: any = null;
    let defQuery: any = null;
    let replaceQuery: any = null;

    try {
      // Tree-sitter 파싱 수행
      const languageObj = await Language.load(wasmPath);
      this.parser.setLanguage(languageObj);
      tree = this.parser.parse(code);

      // 1. 정의(Definition) 탐색 및 마스킹 계획 수립
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

            // 옵션 필터링
            if (tag.includes("var") && !options.maskVars) continue;
            if (tag.includes("func") && !options.maskFuncs) continue;
            if (
              (tag.includes("class") || tag.includes("type")) &&
              !options.maskClasses
            )
              continue;

            // 예외 처리
            if (nodeText.length < 2) continue;
            if (nodeText.startsWith("_")) continue;
            if (activeReserved.has(nodeText)) continue;

            if (!this.mapForward.has(nodeText)) {
              this.getReplacement(nodeText, tag);
            }
          }
        }
      }

      // 2. 전체 코드 스캔 및 실제 치환 수행
      // 식별자뿐만 아니라 문자열 리터럴, 주석 등을 모두 캡처
      const replaceQuerySources = [
        `(identifier) @ident`,
        `(type_identifier) @ident`,
        `(property_identifier) @ident`,
        `(shorthand_property_identifier_pattern) @ident`,
      ];

      if (options.removeComments) {
        replaceQuerySources.push(`(comment) @cmt`);
      }

      if (options.maskStrings) {
        replaceQuerySources.push(`(string) @str`);
        if (
          langId.includes("typescript") ||
          langId.includes("javascript") ||
          langId.includes("react")
        ) {
          replaceQuerySources.push(`(template_string) @str`);
        }
      }

      replaceQuery = new Query(
        this.parser.language,
        replaceQuerySources.join("\n"),
      );

      const captures = replaceQuery.captures(tree.rootNode);
      // 뒤에서부터 교체해야 인덱스가 꼬이지 않음
      captures.sort((a: any, b: any) => b.node.startIndex - a.node.startIndex);

      let resultText = code;

      for (const capture of captures) {
        const node = capture.node;
        const text = node.text; // 원본 텍스트 (예: "Hello World" 또는 identifier)
        const name = capture.name;

        if (name === "cmt") {
          const prefix = "CMT";
          if (!this.typeCounters[prefix]) this.typeCounters[prefix] = 0;
          this.typeCounters[prefix]++;
          const tag = `[[${prefix}_${this.typeCounters[prefix]}]]`;

          let replacement = "";
          // 주석 스타일 판별 및 내용 추출
          if (text.startsWith("//")) {
            // Line comment: // 내용
            this.mapBackward.set(tag, text.substring(2));
            replacement = "//" + tag;
          } else if (text.startsWith("/**")) {
            // Doc block: /** 내용 */
            this.mapBackward.set(tag, text.substring(3, text.length - 2));
            replacement = "/**" + tag + "*/";
          } else if (text.startsWith("/*")) {
            // Standard block: /* 내용 */
            this.mapBackward.set(tag, text.substring(2, text.length - 2));
            replacement = "/*" + tag + "*/";
          } else {
            // Fallback
            this.mapBackward.set(tag, text);
            replacement = tag;
          }

          resultText =
            resultText.substring(0, node.startIndex) +
            replacement +
            resultText.substring(node.endIndex);
        } else if (name === "str") {
          // [중요] 문자열 마스킹: [[STR_1]] 패턴 적용

          // Import/Export 구문의 경로는 마스킹 제외
          const parentType = node.parent ? node.parent.type : "";
          if (
            parentType === "import_statement" ||
            parentType === "export_statement"
          ) {
            continue;
          }

          let maskedToken: string;

          // 이미 마스킹된 문자열인지 확인
          if (this.mapForward.has(text)) {
            maskedToken = this.mapForward.get(text)!;
          } else {
            // 새 고유 ID 생성 (예: "STR_1")
            const prefix = "STR";
            if (!this.typeCounters[prefix]) this.typeCounters[prefix] = 0;
            this.typeCounters[prefix]++;

            // [변경점] 따옴표에 영향받지 않도록 식별자 자체를 안전한 패턴으로 감쌈
            // 예: "Hello" -> "[[STR_1]]"
            // 여기서 [[STR_1]]은 내부 값만 의미하며, 코드 상에서는 따옴표 안에 위치하게 됨
            // 기존 텍스트(text)는 따옴표를 포함하고 있으므로(예: "foo"),
            // 이를 대체할 때도 따옴표를 포함한 형태(예: "[[STR_1]]")로 만들어야 함.

            // 주의: node.text는 따옴표를 포함합니다.
            // 예: "hello" -> length 7

            const rawContent = `[[${prefix}_${this.typeCounters[prefix]}]]`;

            // 원본의 따옴표 스타일(큰따옴표/작은따옴표/백틱)을 유지하거나 통일할 수 있으나,
            // 여기서는 안전하게 쌍따옴표로 통일하여 치환합니다.
            maskedToken = `"${rawContent}"`;

            // 매핑 저장
            // Key: 원본 텍스트 전체 ("hello")
            // Value: 치환된 텍스트 ("[[STR_1]]")
            // Backward Map에서는 [[STR_1]] 태그 자체를 키로 사용하여 복구 시 유연성 확보
            this.mapForward.set(text, maskedToken);

            // Backward Map에는 [[STR_1]] -> "hello" (따옴표 포함 원본) 형태로 저장하지 않고,
            // [[STR_1]] -> hello (내용물만) 저장하거나,
            // 복구 로직의 단순화를 위해 [[STR_1]] 패턴이 발견되면 원본 텍스트(따옴표 포함)로 교체하도록 설정
            this.mapBackward.set(rawContent, text);
          }

          resultText =
            resultText.substring(0, node.startIndex) +
            maskedToken +
            resultText.substring(node.endIndex);
        } else if (this.mapForward.has(text)) {
          // 일반 식별자(변수명 등) 치환
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
   * 단순 텍스트 치환 방식(Regex)을 사용하여 코드를 복구합니다.
   * Tree-sitter를 사용하지 않으므로 속도가 빠르고 구문 오류가 있는 코드에도 작동합니다.
   * 특히 [[STR_1]] 패턴을 사용하여 따옴표 변경(Double <-> Single Quote)에 강건합니다.
   * * @param code 마스킹된(리팩토링된) 코드
   * @param mapTable 복호화 매핑 테이블
   */
  private _restoreByRegex(code: string, mapTable: Map<string, string>): string {
    let restoredCode = code;

    // 1. 문자열 패턴 복구 ([[STR_N]])
    // 정규식 설명:
    // \[\[STR_\d+\]\] 패턴을 찾습니다.
    // 예: '[[STR_1]]' 또는 "[[STR_1]]" 내부의 [[STR_1]]을 매칭
    const stringPattern = /\[\[STR_\d+\]\]/g;

    restoredCode = restoredCode.replace(stringPattern, (match) => {
      if (mapTable.has(match)) {
        // match는 [[STR_1]] 형태
        // mapTable.get(match)는 원본 문자열(따옴표 포함, 예: "Alert Message")

        // 주의: 현재 코드 문맥상 따옴표가 이미 존재할 수 있음.
        // 예: const msg = "[[STR_1]]";
        // 여기서 [[STR_1]]만 "Alert Message"로 바꾸면 -> const msg = ""Alert Message""; (중복 따옴표)
        // 따라서 이 함수를 호출하기 전에, 복구 전략을 잘 세워야 함.

        // 전략 수정:
        // Regex로 치환 시, 주변 따옴표를 포함하여 치환하는 것이 안전함.
        // 하지만 Prettier가 따옴표를 바꿨을 수 있으므로 (예: " -> '),
        // 단순히 내부 값만 교체하는 것이 아니라 "따옴표+태그" 전체를 원본 "따옴표+값"으로 되돌려야 함?
        // 아니면, 태그만 원본 내용(따옴표 제외)으로 되돌려야 하나?

        // 가장 안전한 방법:
        // 원본 매핑에 "따옴표를 포함한 값"이 저장되어 있다면 -> 따옴표를 제거하고 내용물만 넣어야 함.
        // 원본 매핑: [[STR_1]] -> "Hello World"
        // 코드: '[[STR_1]]'

        // 1. 원본 값에서 따옴표 제거 (내용물 추출)
        const originalWithQuotes = mapTable.get(match)!;
        const content = originalWithQuotes.substring(
          1,
          originalWithQuotes.length - 1,
        );

        // 2. 그냥 내용물만 반환 (현재 코드의 따옴표 유지)
        return content;
      }
      return match;
    });

    // 2. 주석 패턴 복구 ([[CMT_N]])
    // 마스킹 시 기호(//, /* */)를 남겨두었으므로, 태그 자체만 원본 내용으로 치환하여 스타일을 유지합니다.
    const commentPattern = /\[\[CMT_\d+\]\]/g;
    restoredCode = restoredCode.replace(commentPattern, (match) => {
      if (mapTable.has(match)) {
        return mapTable.get(match)!;
      }
      return match;
    });

    // 3. 식별자(변수명 등) 복구
    // 식별자는 단어 경계(\b)를 사용하여 정확히 매칭
    // 문자열 복구 후 실행하여 충돌 방지
    mapTable.forEach((originalName, maskedName) => {
      if (maskedName.startsWith("STR")) return; // 문자열은 위에서 처리됨
      if (maskedName.startsWith("[[")) return; // 태그형은 위에서 처리됨

      // 전역 치환 (g 플래그)
      const regex = new RegExp(`\\b${maskedName}\\b`, "g");
      restoredCode = restoredCode.replace(regex, originalName);
    });

    return restoredCode;
  }

  public async restoreWithMap(
    code: string,
    mapping: string | Record<string, string> | Map<string, string>,
    langId: string, // Regex 방식 사용 시 미사용 가능하나 인터페이스 유지
  ): Promise<string> {
    let restorationMap = new Map<string, string>();

    // 매핑 데이터 정규화
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
      for (const [k, v] of Object.entries(mapping))
        restorationMap.set(k, v as string);
    }

    this.mapBackward = restorationMap;

    // Regex 기반 복구 실행 (Tree-sitter보다 따옴표 변경 이슈에 강함)
    return this._restoreByRegex(code, restorationMap);
  }

  public async restore(code: string, langId: string): Promise<string> {
    return this.restoreWithMap(code, this.mapBackward, langId);
  }
}
