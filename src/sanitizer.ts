import * as vscode from "vscode";
import * as path from "path";

const { Parser, Language, Query } = require("web-tree-sitter");

// [핵심 전략] "정의(Definition)"를 찾아내는 정밀한 쿼리
// 단순 사용(Usage)이 아니라, 변수나 함수가 '처음 태어나는 곳'만 타겟팅합니다.
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
        
        ; 3. 변수 선언 (단, Destructuring {x} = obj 은 제외하고 단순 선언만 타겟팅)
        (variable_declarator name: (identifier) @def.var)
        
        ; 4. 함수 파라미터 (단순 식별자만)
        (required_parameter (identifier) @def.var)
        (optional_parameter (identifier) @def.var)
    `,
};

// React 등에서도 그대로 사용 가능
QUERIES["typescriptreact"] = QUERIES["typescript"];
QUERIES["javascript"] = QUERIES["typescript"];
QUERIES["javascriptreact"] = QUERIES["typescript"];

export class AutoCodeSanitizer {
  private parser: any = null;
  private extensionPath: string;

  // 변환 테이블 (Scope별로 관리하지 않고 파일 단위 전역 관리 - MVP 최적화)
  private mapForward = new Map<string, string>();
  private mapBackward = new Map<string, string>();
  private typeCounters = { var: 0, func: 0, class: 0, type: 0 };

  constructor(extensionPath: string) {
    this.extensionPath = extensionPath;
  }

  public async init() {
    if (this.parser) return;
    try {
      const wasmName = "web-tree-sitter.wasm";
      const wasmPath = path.join(this.extensionPath, "parsers", wasmName);
      await Parser.init({ locateFile: () => wasmPath });
      this.parser = new Parser();
    } catch (e) {
      console.error(e);
      throw new Error(`Tree-sitter init failed: ${e}`);
    }
  }

  private getReplacement(originalText: string, category: string): string {
    // 이미 변환된 적 있는 단어라면(예: 정의부에서 변환됨), 사용부에서도 똑같이 변환
    if (this.mapForward.has(originalText))
      return this.mapForward.get(originalText)!;

    // 카운터 증가 및 새 이름 생성 (예: VAR_1, FUNC_3)
    const prefix = category.toUpperCase().split(".")[1] || "VAR"; // def.func -> FUNC
    const counterKey = prefix.toLowerCase();

    // 카운터 안전하게 증가
    if (typeof (this.typeCounters as any)[counterKey] === "number") {
      (this.typeCounters as any)[counterKey]++;
    } else {
      this.typeCounters.var++; // Fallback
    }

    const count =
      (this.typeCounters as any)[counterKey] || this.typeCounters.var;
    const replacement = `${prefix}_${count}`;

    this.mapForward.set(originalText, replacement);
    this.mapBackward.set(replacement, originalText);
    return replacement;
  }

  public async sanitize(
    code: string,
    langId: string,
    options: { maskVars: boolean; maskFuncs: boolean; maskClasses: boolean },
  ): Promise<{ sanitized: string; mapping: any }> {
    if (!this.parser) await this.init();

    // 1. 언어 설정
    let langFile = "";
    let queryKey = langId;

    if (langId === "python") langFile = "tree-sitter-python.wasm";
    else if (langId.includes("typescript") || langId.includes("javascript")) {
      langFile = "tree-sitter-typescript.wasm";
      if (!QUERIES[langId]) queryKey = "typescript";
    } else {
      vscode.window.showWarningMessage(`지원하지 않는 언어: ${langId}`);
      return { sanitized: code, mapping: {} };
    }

    const langPath = path.join(this.extensionPath, "parsers", langFile);
    try {
      const lang = await Language.load(langPath);
      this.parser.setLanguage(lang);
    } catch (e) {
      vscode.window.showErrorMessage(`Language load failed: ${langFile}`);
      return { sanitized: code, mapping: {} };
    }

    const tree = this.parser.parse(code);
    const queryStr = QUERIES[queryKey];

    if (!queryStr) return { sanitized: code, mapping: {} };

    // 2. [1차 패스] 정의(Definition) 수집
    // "이 파일에서 태어난 변수들"을 먼저 싹 긁어모아 매핑 테이블을 만듭니다.
    let query;
    try {
      query = new Query(this.parser.language, queryStr);
    } catch (e) {
      console.error("Query Error:", e);
      return { sanitized: code, mapping: {} };
    }

    const definitions = query.matches(tree.rootNode);

    // 정의된 식별자들을 매핑 테이블에 등록
    for (const match of definitions) {
      for (const capture of match.captures) {
        const text = capture.node.text;
        const type = capture.name; // @def.var, @def.func 등

        // [추가] 사용자 설정에 따라 스킵
        if (type.includes("var") && !options.maskVars) continue;
        if (type.includes("func") && !options.maskFuncs) continue;
        if (
          (type.includes("class") || type.includes("type")) &&
          !options.maskClasses
        )
          continue;

        if (text.length < 2) continue;
        if (text.startsWith("_")) continue;

        if (!this.mapForward.has(text)) {
          this.getReplacement(text, type);
        }
      }
    }

    // 3. [2차 패스] 전체 치환 (Global Replacement)
    // 코드 전체를 훑으면서, 위에서 등록된 단어가 나오면 무조건 바꿉니다.
    // 등록되지 않은 단어(React, useState, console 등)는 건드리지 않습니다.

    // 단순 텍스트 치환 대신, Tree-sitter의 모든 identifier 노드를 순회하며 안전하게 치환
    const identQuery = new Query(
      this.parser.language,
      `
            (identifier) @ident
            (type_identifier) @ident
            (property_identifier) @ident
        `,
    );
    const allCaptures = identQuery.captures(tree.rootNode);

    // 뒤에서부터 치환해야 인덱스가 밀리지 않음
    allCaptures.sort((a: any, b: any) => b.node.startIndex - a.node.startIndex);

    let sanitizedCode = code;

    for (const capture of allCaptures) {
      const node = capture.node;
      const text = node.text;

      // 매핑 테이블에 있는 단어인가? (즉, 이 파일에서 정의된 변수인가?)
      if (this.mapForward.has(text)) {
        const replacement = this.mapForward.get(text)!;

        sanitizedCode =
          sanitizedCode.substring(0, node.startIndex) +
          replacement +
          sanitizedCode.substring(node.endIndex);
      }
      // 매핑 테이블에 없다면? -> 외부 라이브러리나 키워드이므로 보존!
    }

    // 메모리 정리
    if (query.delete) query.delete();
    if (identQuery.delete) identQuery.delete();
    if (tree.delete) tree.delete();

    return {
      sanitized: sanitizedCode,
      mapping: Object.fromEntries(this.mapBackward),
    };
  }
}
