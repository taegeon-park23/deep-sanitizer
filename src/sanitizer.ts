import * as vscode from "vscode";
import * as path from "path";

const { Parser, Language, Query } = require("web-tree-sitter");

// [핵심 전략] "정의(Definition)"를 찾아내는 정밀한 쿼리
const QUERIES: Record<string, string> = {
  // Python 정의 패턴
  python: `
        (function_definition name: (identifier) @def.func)
        (class_definition name: (identifier) @def.class)
        (parameter (identifier) @def.var)
        (assignment left: (identifier) @def.var)
    `,
  // TypeScript/TSX 정의 패턴
  typescript: `
        ; 1. 함수 및 클래스 선언
        (function_declaration name: (identifier) @def.func)
        (class_declaration name: (type_identifier) @def.class)
        (method_definition name: (property_identifier) @def.func)
        
        ; 2. 타입 및 인터페이스
        (interface_declaration name: (type_identifier) @def.type)
        (type_alias_declaration name: (type_identifier) @def.type)
        (enum_declaration name: (identifier) @def.type)
        
        ; 3. 변수 선언 (Destructuring 제외)
        (variable_declarator name: (identifier) @def.var)
        
        ; 4. 함수 파라미터
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
  private extensionPath: string; // Base Path

  // 변환 테이블
  private mapForward = new Map<string, string>();
  private mapBackward = new Map<string, string>();
  private typeCounters = { var: 0, func: 0, class: 0, type: 0 };

  /**
   * Helper: 언어 ID에 따른 WASM 파일명 반환
   */
  private _getWasmFile(languageId: string): string {
    if (languageId === "python") {
      return "tree-sitter-python.wasm";
    }
    if (languageId === "typescriptreact" || languageId === "javascriptreact") {
      return "tree-sitter-tsx.wasm";
    }
    if (languageId === "typescript" || languageId === "javascript") {
      return "tree-sitter-typescript.wasm";
    }
    return ""; // Not supported
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
   * 이름 마스킹 생성 로직
   */
  private getReplacement(originalName: string, typeTag: string): string {
    if (this.mapForward.has(originalName))
      return this.mapForward.get(originalName)!;

    let prefix = "VAR";

    // 1. 카테고리별 기본 접두사
    if (typeTag.includes("func")) prefix = "ACTION";
    else if (typeTag.includes("class")) prefix = "ENTITY";
    else if (typeTag.includes("type")) prefix = "TYPE";

    // 2. 이름 기반 지능형 접두사
    if (originalName.endsWith("Props")) prefix = "PROPS_DEF";
    else if (originalName === "props") prefix = "PROPS";
    else if (originalName.startsWith("use") && originalName.length > 3)
      prefix = "HOOK";
    else if (originalName.match(/^(is|has|can|should|did)[A-Z]/))
      prefix = "BOOL";
    else if (originalName.match(/(List|Array|Items|Collection)$/))
      prefix = "LIST";
    else if (originalName.match(/(Id|Key|Index|Code)$/)) prefix = "ID";
    else if (originalName.match(/^(on|handle)[A-Z]/)) prefix = "HANDLER";

    const key = prefix.toLowerCase();

    if (typeof (this.typeCounters as any)[key] !== "number") {
      (this.typeCounters as any)[key] = 0;
    }
    (this.typeCounters as any)[key]++;

    const count = (this.typeCounters as any)[key];
    const maskedName = `${prefix}_${count}`;

    this.mapForward.set(originalName, maskedName);
    this.mapBackward.set(maskedName, originalName);
    return maskedName;
  }

  /**
   * Main: Sanitize / Obfuscate Code
   */
  public async sanitize(
    code: string, // Source Code
    langId: string, // Language ID
    options: { maskVars: boolean; maskFuncs: boolean; maskClasses: boolean },
  ): Promise<{ sanitized: string; mapping: any }> {
    if (!this.parser) await this.init();

    const wasmFile = this._getWasmFile(langId);
    if (!wasmFile) {
      vscode.window.showWarningMessage(`지원하지 않는 언어: ${langId}`);
      return { sanitized: code, mapping: {} };
    }

    const wasmPath = path.join(this.extensionPath, "parsers", wasmFile);
    let languageObj;

    try {
      languageObj = await Language.load(wasmPath);
      this.parser.setLanguage(languageObj);
    } catch (e) {
      console.error(e);
      vscode.window.showErrorMessage(
        `Parser load failed: ${wasmFile} (Ensure parsers folder exists)`,
      );
      return { sanitized: code, mapping: {} };
    }

    // 쿼리 키 설정 (React는 TypeScript 쿼리 사용)
    let queryKey = langId;
    if (
      langId === "typescriptreact" ||
      langId === "javascriptreact" ||
      langId === "javascript"
    ) {
      queryKey = "typescript";
    }

    const defQueryStr = QUERIES[queryKey];
    if (!defQueryStr) return { sanitized: code, mapping: {} };

    let tree: any = null;
    let defQuery: any = null;
    let replaceQuery: any = null;

    try {
      tree = this.parser.parse(code);
      defQuery = new Query(this.parser.language, defQueryStr);

      const matches = defQuery.matches(tree.rootNode);

      // 1. [Pass 1] 정의(Definition) 수집 및 매핑 생성
      for (const match of matches) {
        for (const capture of match.captures) {
          // VAR_24 assumed to be 'captures'
          const nodeText = capture.node.text; // VAR_23=node, VAR_19=text
          const tag = capture.name;

          if (tag.includes("var") && !options.maskVars) continue;
          if (tag.includes("func") && !options.maskFuncs) continue;
          if (
            (tag.includes("class") || tag.includes("type")) &&
            !options.maskClasses
          )
            continue;

          if (nodeText.length < 2) continue;
          if (nodeText.startsWith("_")) continue;

          if (!this.mapForward.has(nodeText)) {
            this.getReplacement(nodeText, tag);
          }
        }
      }

      // 2. [Pass 2] 전체 치환 (Global Replacement)
      replaceQuery = new Query(
        this.parser.language,
        `
          (identifier) @ident
          (type_identifier) @ident
          (property_identifier) @ident
          (shorthand_property_identifier_pattern) @ident
          (statement_identifier) @ident
        `,
      );

      const captures = replaceQuery.captures(tree.rootNode);
      // Reverse sort to replace safely without index shifting
      captures.sort((a: any, b: any) => b.node.startIndex - a.node.startIndex);

      let resultText = code;

      for (const capture of captures) {
        const node = capture.node;
        const text = node.text;

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
      // [Memory Cleanup] 중요: WASM 객체 해제
      if (tree) tree.delete();
      if (defQuery) defQuery.delete();
      if (replaceQuery) replaceQuery.delete();
    }
  }

  /**
   * Core logic for restoring obfuscated code
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
        const text = node.text; // node.text

        if (mapTable.has(text)) {
          const original = mapTable.get(text)!;
          restoredCode =
            restoredCode.substring(0, node.startIndex) +
            original +
            restoredCode.substring(node.endIndex);
        }
      }

      return restoredCode;
    } catch (e) {
      throw new Error(`Restoration failed: ${e}`);
    } finally {
      if (tree) tree.delete();
      if (query) query.delete();
    }
  }

  public async restore(code: string, langId: string): Promise<string> {
    if (!this.parser) await this.init();
    // Uses internal memory map
    return this._applyRestoration(code, langId, this.mapBackward);
  }

  public async restoreFromOutput(fullText: string): Promise<string> {
    if (!this.parser) await this.init();

    // 1. Extract JSON Map
    const jsonMatch = fullText.match(/map table\s*```json\s*([\s\S]*?)\s*```/i);
    let extractedMap: Record<string, string> = {};

    if (jsonMatch && jsonMatch[1]) {
      try {
        extractedMap = JSON.parse(jsonMatch[1]);
      } catch (e) {
        throw new Error("Invalid Map Table JSON.");
      }
    } else {
      console.warn("No Map Table found. Using memory cache.");
    }

    // 2. Extract Code
    const codeMatch = fullText.match(/code\s*```[\w+]*\s*([\s\S]*?)\s*```/i);
    let targetCode = codeMatch && codeMatch[1] ? codeMatch[1] : fullText;

    // 3. Update Map
    if (Object.keys(extractedMap).length > 0) {
      this.mapBackward.clear();
      for (const [masked, original] of Object.entries(extractedMap)) {
        this.mapBackward.set(masked, original);
      }
    }

    if (this.mapBackward.size === 0) {
      throw new Error("No mapping info available for restoration.");
    }

    // Default to typescript for blind restoration
    return this._applyRestoration(targetCode, "typescript", this.mapBackward);
  }

  public async restoreWithMap(
    code: string, // Obfuscated Code
    mappingJson: string, // JSON Map String
    langId: string, // Language ID
  ): Promise<string> {
    if (!this.parser) await this.init();

    let parsedMap: Record<string, string>;
    try {
      parsedMap = JSON.parse(mappingJson);
    } catch (e) {
      throw new Error("Invalid JSON format for Map Table.");
    }

    const restorationMap = new Map<string, string>();
    for (const [masked, original] of Object.entries(parsedMap)) {
      restorationMap.set(masked, original);
    }

    // Sync internal map as well
    this.mapBackward = restorationMap;

    return this._applyRestoration(code, langId, restorationMap);
  }
}
