// src/extension.ts
import * as vscode from "vscode";
import { AutoCodeSanitizer } from "./sanitizer";

export function activate(context: vscode.ExtensionContext) {
  const sanitizer = new AutoCodeSanitizer(context.extensionPath);

  // 1. [기존 수정] 암호화 (Sanitize) 명령어
  const sanitizeDisposable = vscode.commands.registerCommand(
    "deep-sanitizer.sanitize",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      try {
        await sanitizer.init();
      } catch (e: any) {
        vscode.window.showErrorMessage(e.message);
        return;
      }

      const document = editor.document;
      const selection = editor.selection;
      const text = selection.isEmpty
        ? document.getText()
        : document.getText(selection);
      const langId = document.languageId;

      // 설정값 로드
      const config = vscode.workspace.getConfiguration("deepSanitizer");
      const options = {
        maskVars: config.get<boolean>("maskVariables", true),
        maskFuncs: config.get<boolean>("maskFunctions", true),
        maskClasses: config.get<boolean>("maskClasses", true),
        autoCopy: config.get<boolean>("copyToClipboard", true),
      };

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "보안 처리 중...",
        },
        async () => {
          const result = await sanitizer.sanitize(text, langId, options);
          const mappingJson = JSON.stringify(result.mapping, null, 2);

          // [핵심 변경] 사용자가 요청한 포맷으로 출력 생성
          const outputTemplate = `prompt:
\`\`\`txt
You are an expert developer. Refactor or fix the code below.
IMPORTANT: The code is sanitized for security (e.g., VAR_1, FUNC_1). 
1. Analyze the logic flow despite the obfuscated names.
2. Do NOT change the variable names (keep VAR_1 as VAR_1).
3. If you create NEW variables, use meaningful names.
4. Return the result in the same format: Code block first, then the Map table block.
\`\`\`

code
\`\`\`${langId}
${result.sanitized}
\`\`\`

map table
\`\`\`json
${mappingJson}
\`\`\``;

          // 새 창에 띄우기 (언어를 Markdown으로 설정하여 하이라이팅 지원)
          const newDoc = await vscode.workspace.openTextDocument({
            content: outputTemplate,
            language: "markdown",
          });
          await vscode.window.showTextDocument(newDoc);

          if (options.autoCopy) {
            await vscode.env.clipboard.writeText(outputTemplate);
            vscode.window.showInformationMessage(
              "복사 완료! AI에게 그대로 붙여넣으세요.",
            );
          }
        },
      );
    },
  );

  // 2. [신규 추가] 복호화 (Restore) 명령어
  const restoreDisposable = vscode.commands.registerCommand(
    "deep-sanitizer.restore",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage(
          "복구할 코드가 있는 에디터를 열어주세요.",
        );
        return;
      }

      // 1. 복구할 대상 텍스트 가져오기 (선택 영역 우선, 없으면 전체)
      const document = editor.document;
      const selection = editor.selection;
      const targetText = selection.isEmpty
        ? document.getText()
        : document.getText(selection);

      const langId = document.languageId;

      // 2. Input Box 띄우기 (Map Table 입력 요청)
      const mappingJson = await vscode.window.showInputBox({
        title: "Map Table 입력",
        prompt:
          'JSON 형태의 매핑 테이블을 붙여넣으세요. (예: {"VAR_1": "user"})',
        placeHolder: '{"VAR_1": "originalName", ...}',
        ignoreFocusOut: true, // 다른 곳 클릭해도 닫히지 않게
        validateInput: (value) => {
          try {
            JSON.parse(value);
            return null; // 유효함
          } catch {
            return "올바른 JSON 형식이 아닙니다.";
          }
        },
      });

      if (!mappingJson) return; // 사용자가 취소함

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "코드 복구 중...",
          },
          async () => {
            // 3. 복호화 실행
            const restoredCode = await sanitizer.restoreWithMap(
              targetText,
              mappingJson,
              langId,
            );

            // 4. 결과 적용 (선택 영역을 복구된 코드로 교체)
            await editor.edit((editBuilder) => {
              if (selection.isEmpty) {
                // 전체 교체
                const fullRange = new vscode.Range(
                  document.positionAt(0),
                  document.positionAt(document.getText().length),
                );
                editBuilder.replace(fullRange, restoredCode);
              } else {
                // 선택 영역 교체
                editBuilder.replace(selection, restoredCode);
              }
            });

            vscode.window.showInformationMessage("성공적으로 복구되었습니다!");
          },
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`복구 실패: ${e.message}`);
      }
    },
  );

  context.subscriptions.push(sanitizeDisposable);
  context.subscriptions.push(restoreDisposable);
}

export function deactivate() {}
