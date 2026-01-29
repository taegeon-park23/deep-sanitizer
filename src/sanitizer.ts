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
    if (this.mapForward.has(originalText))
      return this.mapForward.get(originalText)!;

    let prefix = "VAR";

    // 1. 카테고리별 기본 접두사
    if (category.includes("func")) prefix = "ACTION";
    else if (category.includes("class")) prefix = "ENTITY";
    else if (category.includes("type")) prefix = "TYPE";

    // 2. [추가] 이름 기반 지능형 접두사 (React/TypeScript 패턴)
    if (originalText.endsWith("Props"))
      prefix = "PROPS_DEF"; // 예: AlertModalProps
    else if (originalText === "props")
      prefix = "PROPS"; // 예: props
    else if (originalText.startsWith("use") && originalText.length > 3)
      prefix = "HOOK"; // 예: useTranslation
    else if (originalText.match(/^(is|has|can|should|did)[A-Z]/))
      prefix = "BOOL";
    else if (originalText.match(/(List|Array|Items|Collection)$/))
      prefix = "LIST";
    else if (originalText.match(/(Id|Key|Index|Code)$/)) prefix = "ID";
    else if (originalText.match(/^(on|handle)[A-Z]/)) prefix = "HANDLER";

    const counterKey = prefix.toLowerCase();

    if (typeof (this.typeCounters as any)[counterKey] !== "number") {
      (this.typeCounters as any)[counterKey] = 0;
    }
    (this.typeCounters as any)[counterKey]++;

    const count = (this.typeCounters as any)[counterKey];
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
    let queryKey = "typescript"; // 기본 쿼리셋

    if (langId === "python") {
      langFile = "tree-sitter-python.wasm";
      queryKey = "python";
    }
    // React(TSX/JSX)인 경우 -> 반드시 tree-sitter-tsx 사용
    else if (langId === "typescriptreact" || langId === "javascriptreact") {
      langFile = "tree-sitter-tsx.wasm"; // TSX 전용 파서
      queryKey = "typescriptreact";
    }
    // 일반 TS/JS인 경우 -> tree-sitter-typescript 사용
    else if (langId === "typescript" || langId === "javascript") {
      langFile = "tree-sitter-typescript.wasm";
      queryKey = "typescript";
    } else {
      vscode.window.showWarningMessage(`지원하지 않는 언어: ${langId}`);
      return { sanitized: code, mapping: {} };
    }

    const langPath = path.join(this.extensionPath, "parsers", langFile);

    // 언어 로드 및 파서 설정
    try {
      const lang = await Language.load(langPath);
      this.parser.setLanguage(lang);
    } catch (e) {
      console.error(e);
      vscode.window.showErrorMessage(
        `Parser load failed: ${langFile} (파일이 parsers 폴더에 있나요?)`,
      );
      return { sanitized: code, mapping: {} };
    }

    // [중요] 쿼리 매핑 확인 (TSX도 TypeScript 쿼리 재사용 가능)
    // 상단 QUERIES 객체에 typescriptreact가 정의되어 있어야 합니다.
    // const QUERIES = { ..., typescriptreact: QUERIES['typescript'], ... } 확인 필요
    const tree = this.parser.parse(code);
    const queryStr = QUERIES[queryKey] || QUERIES["typescript"];

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
        (shorthand_property_identifier_pattern) @ident  ; { props } 같은 패턴 포착
        (statement_identifier) @ident                   ; 라벨 등
      `,
    );

    // 주의: JSX 내부에서는 identifier가 중첩되어 잡힐 수 있으므로
    // 가장 작은 단위(최하위 노드)가 우선시되거나, 중복 치환을 방지해야 하지만
    // Tree-sitter의 identifier는 보통 Leaf 노드에 가까우므로
    // "뒤에서부터 치환(Reverse Sort)" 전략을 쓰면 안전합니다.
    const allCaptures = identQuery.captures(tree.rootNode);
    allCaptures.sort((a: any, b: any) => b.node.startIndex - a.node.startIndex);

    let sanitizedCode = code;

    for (const capture of allCaptures) {
      const node = capture.node;
      const text = node.text;

      // 부모 노드가 Member Expression의 'property'인 경우 치환 제외 (옵션)
      // 예: user.name 에서 'name'은 보통 속성이므로 변환 안 함 (메서드는 제외)
      // 단, 사용자가 "모든 속성까지 변환"을 원하면 이 검사는 뺍니다.
      // 현재 프로젝트 성격상(외부 라이브러리 보존) 속성 접근자는 건드리지 않는 게 안전할 수 있습니다.

      // 여기서는 매핑 테이블에 "있는 것만" 바꾸므로 안전합니다.
      if (this.mapForward.has(text)) {
        const replacement = this.mapForward.get(text)!;
        sanitizedCode =
          sanitizedCode.substring(0, node.startIndex) +
          replacement +
          sanitizedCode.substring(node.endIndex);
      }
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

  // [신규] 복호화 메서드 추가
  public async restore(code: string, langId: string): Promise<string> {
    if (!this.parser) await this.init();

    // 언어 설정 (sanitize 메서드와 동일한 로직 필요 - 생략되었으나 동일하게 언어 로드 필요)
    // 실제 구현 시엔 언어 로드 로직을 별도 메서드(ensureLanguage)로 분리하는 것이 좋습니다.
    // 여기서는 간단히 설명합니다.

    const tree = this.parser.parse(code);

    // 식별자만 찾아서 복구 (주석이나 일반 문자열은 건드리지 않음)
    const queryStr = `
        (identifier) @ident
        (type_identifier) @ident
        (property_identifier) @ident
    `;
    const query = new Query(this.parser.language, queryStr);
    const captures = query.captures(tree.rootNode);

    // 인덱스가 밀리지 않도록 뒤에서부터 교체
    captures.sort((a: any, b: any) => b.node.startIndex - a.node.startIndex);

    let restoredCode = code;

    for (const capture of captures) {
      const text = capture.node.text;
      // 역매핑 테이블에 존재하는 단어인지 확인
      if (this.mapBackward.has(text)) {
        const original = this.mapBackward.get(text)!;
        restoredCode =
          restoredCode.substring(0, capture.node.startIndex) +
          original +
          restoredCode.substring(capture.node.endIndex);
      }
    }

    return restoredCode;
  }

  public async restoreFromOutput(fullText: string): Promise<string> {
    if (!this.parser) await this.init();

    // 1. JSON 매핑 테이블 추출 (정규식 사용)
    // ```json ... ``` 사이의 내용을 찾습니다.
    const mapMatch = fullText.match(/map table\s*```json\s*([\s\S]*?)\s*```/i);
    let mapping: Record<string, string> = {};

    if (mapMatch && mapMatch[1]) {
      try {
        mapping = JSON.parse(mapMatch[1]);
      } catch (e) {
        throw new Error(
          "매핑 테이블 JSON 파싱 실패. JSON 형식을 확인해주세요.",
        );
      }
    } else {
      // 매핑 테이블을 못 찾으면 경고 후, 현재 메모리에 있는 맵 사용 시도
      console.warn(
        "텍스트에서 매핑 테이블을 찾을 수 없습니다. 메모리 캐시를 사용합니다.",
      );
    }

    // 2. 코드 블록 추출
    // ```typescript ... ``` 또는 ``` ... ``` 사이의 내용을 찾습니다.
    const codeMatch = fullText.match(/code\s*```[\w+]*\s*([\s\S]*?)\s*```/i);
    let targetCode = "";

    if (codeMatch && codeMatch[1]) {
      targetCode = codeMatch[1];
    } else {
      // 코드 블록 형식이 아니면 전체 텍스트를 코드로 간주 (사용자가 코드만 붙여넣었을 경우)
      targetCode = fullText;
    }

    // 3. 매핑 정보 업데이트 (외부에서 입력받은 JSON으로 덮어쓰기)
    if (Object.keys(mapping).length > 0) {
      this.mapBackward.clear();
      for (const [masked, original] of Object.entries(mapping)) {
        this.mapBackward.set(masked, original);
      }
    }

    if (this.mapBackward.size === 0) {
      throw new Error(
        "복호화할 매핑 정보가 없습니다. JSON 테이블을 포함해주세요.",
      );
    }

    // 4. 복호화 실행 (Tree-sitter 사용)
    // 언어는 TypeScript로 가정 (필요시 파라미터로 분리 가능)
    const langPath = path.join(
      this.extensionPath,
      "parsers",
      "tree-sitter-typescript.wasm",
    );
    await this.parser.setLanguage(await Language.load(langPath));

    const tree = this.parser.parse(targetCode);

    // 식별자(Identifier)만 찾아서 안전하게 치환
    const query = new Query(
      this.parser.language,
      `
      (identifier) @ident
      (type_identifier) @ident
      (property_identifier) @ident
    `,
    );

    const captures = query.captures(tree.rootNode);
    // 인덱스 밀림 방지를 위해 뒤에서부터 정렬
    captures.sort((a: any, b: any) => b.node.startIndex - a.node.startIndex);

    let restoredCode = targetCode;

    for (const capture of captures) {
      const text = capture.node.text;
      if (this.mapBackward.has(text)) {
        const original = this.mapBackward.get(text)!;
        restoredCode =
          restoredCode.substring(0, capture.node.startIndex) +
          original +
          restoredCode.substring(capture.node.endIndex);
      }
    }

    return restoredCode;
  }

  public async restoreWithMap(
    code: string,
    mappingJson: string,
    langId: string,
  ): Promise<string> {
    if (!this.parser) await this.init();

    // 1. JSON 파싱 검증
    let mapping: Record<string, string>;
    try {
      mapping = JSON.parse(mappingJson);
    } catch (e) {
      throw new Error(
        "유효하지 않은 JSON 형식입니다. Map Table을 확인해주세요.",
      );
    }

    // 2. 역방향 맵 구성
    this.mapBackward.clear();
    for (const [masked, original] of Object.entries(mapping)) {
      this.mapBackward.set(masked, original);
    }

    // 3. [수정됨] 언어 로드 (sanitize와 동일한 로직 적용)
    let langFile = "";

    if (langId === "python") {
      langFile = "tree-sitter-python.wasm";
    }
    // React(TSX/JSX)인 경우 -> TSX 파서 사용
    else if (langId === "typescriptreact" || langId === "javascriptreact") {
      langFile = "tree-sitter-tsx.wasm";
    }
    // 일반 TS/JS인 경우 -> TypeScript 파서 사용
    else if (langId === "typescript" || langId === "javascript") {
      langFile = "tree-sitter-typescript.wasm";
    } else {
      // Fallback: TSX 파일일 수도 있으므로 안전하게 TSX 파서를 시도하거나 TS 파서 사용
      // 여기서는 기본값을 TS로 둡니다.
      langFile = "tree-sitter-typescript.wasm";
    }

    const langPath = path.join(this.extensionPath, "parsers", langFile);
    try {
      await this.parser.setLanguage(await Language.load(langPath));
    } catch (e) {
      // 파서 로드 실패 시 에러 처리
      throw new Error(
        `Failed to load language parser for restoration: ${langFile}`,
      );
    }

    // 4. 파싱 및 치환
    const tree = this.parser.parse(code);

    const query = new Query(
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
      const text = capture.node.text;
      if (this.mapBackward.has(text)) {
        const original = this.mapBackward.get(text)!;
        restoredCode =
          restoredCode.substring(0, capture.node.startIndex) +
          original +
          restoredCode.substring(capture.node.endIndex);
      }
    }

    return restoredCode;
  }
}
