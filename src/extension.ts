import * as vscode from "vscode";
import { AutoCodeSanitizer } from "./sanitizer";

export function activate(context: vscode.ExtensionContext) {
  const sanitizer = new AutoCodeSanitizer(context.extensionPath);

  let disposable = vscode.commands.registerCommand(
    "deep-sanitizer.sanitize",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("파일을 열어주세요.");
        return;
      }

      try {
        await sanitizer.init();
      } catch (e: any) {
        vscode.window.showErrorMessage(e.message);
        return;
      }

      const document = editor.document;
      // 선택 영역이 있으면 선택 영역만, 없으면 전체 파일
      const selection = editor.selection;
      const text = selection.isEmpty
        ? document.getText()
        : document.getText(selection);
      const langId = document.languageId;

      // 1. 설정값 읽어오기
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
          cancellable: false,
        },
        async () => {
          // 2. 난독화 실행 (옵션 전달)
          const result = await sanitizer.sanitize(text, langId, options);

          const mappingJson = JSON.stringify(result.mapping, null, 2);
          const finalOutput =
            `// Sanitized Code (${langId})\n` +
            result.sanitized +
            `\n\n/* --- MAPPING TABLE (Do not share) --- \n${mappingJson}\n*/`;

          // 3. 결과 처리: 새 창 띄우기
          const newDoc = await vscode.workspace.openTextDocument({
            content: finalOutput,
            language: langId,
          });
          await vscode.window.showTextDocument(newDoc);

          // 4. 결과 처리: 클립보드 자동 복사
          if (options.autoCopy) {
            await vscode.env.clipboard.writeText(result.sanitized); // 매핑 테이블 제외하고 코드만 복사
            vscode.window.showInformationMessage(
              "🔒 코드가 난독화되어 클립보드에 복사되었습니다!",
            );
          }
        },
      );
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
