import * as vscode from "vscode";
import * as path from "path";
import { AutoCodeSanitizer } from "./sanitizer";

// 프롬프트 타입 정의
type PromptType = "refactor" | "unittest" | "inspect" | "flowchart";

// 기본 프롬프트 템플릿 (Config가 비어있을 경우 사용)
const DEFAULT_TEMPLATES: Record<PromptType, string> = {
  refactor: `prompt:
\`\`\`txt
You are an expert developer. Refactor the code below.
IMPORTANT: The code is sanitized for security.
1. Analyze the logic flow based on the structure.
2. KEEP the sanitized variable names (e.g., VAR_1, ACTION_1, [[STR_1]]) EXACTLY as they are.
3. DO NOT attempt to de-obfuscate or guess original names.
4. If you create NEW variables, use meaningful names.
5. Return ONLY the code block in {langId}.
\`\`\`

code
\`\`\`{langId}
{code}
\`\`\``,

  unittest: `prompt:
\`\`\`txt
You are an expert QA Engineer. Generate comprehensive Unit Tests for the code below.
IMPORTANT: The code is sanitized for security.
1. Treat sanitized names (e.g., VAR_1, ACTION_1) as opaque identifiers.
2. Generate tests that cover edge cases and happy paths based on the logic flow.
3. Use standard testing frameworks (e.g., Jest, JUnit, PyTest) suitable for {langId}.
4. Do NOT attempt to de-obfuscate names. Use the sanitized names in the test code.
5. Return ONLY the test code block.
\`\`\`

code
\`\`\`{langId}
{code}
\`\`\``,

  inspect: `prompt:
\`\`\`txt
You are a Senior Security & Code Reviewer. Inspect the code below for potential issues.
IMPORTANT: The code is sanitized for security.
1. Analyze for Logic Errors, Performance Bottlenecks, and Security Vulnerabilities.
2. Ignore variable naming issues as they are intentionally sanitized.
3. Focus on algorithmic efficiency and structural integrity.
4. Provide a bulleted list of findings and suggested fixes.
\`\`\`

code
\`\`\`{langId}
{code}
\`\`\``,

  flowchart: `prompt:
\`\`\`txt
You are a System Architect. Create a Flowchart describing the logic of the code below.
IMPORTANT: The code is sanitized for security.
1. Use Mermaid.js syntax (graph TD).
2. Represent the control flow (if/else, loops) clearly.
3. Use the sanitized names (ACTION_1, VAR_1) in the nodes.
4. Return ONLY the Mermaid code block.
\`\`\`

code
\`\`\`{langId}
{code}
\`\`\``,
};

/**
 * Diff View를 위한 가상 문서 제공자
 * 메모리에 저장된 복원 코드를 VS Code 문서처럼 제공합니다.
 */
class RestorationProvider implements vscode.TextDocumentContentProvider {
  // URI 별 복원된 텍스트 저장소
  private _documents = new Map<string, string>();
  // 문서 변경 알림 이벤트 이미터
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();

  get onDidChange() {
    return this._onDidChange.event;
  }

  // 외부에서 텍스트 업데이트 시 호출
  public update(uri: vscode.Uri, content: string) {
    this._documents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  // VS Code가 문서 내용을 요청할 때 호출
  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this._documents.get(uri.toString()) || "";
  }
}

export function activate(context: vscode.ExtensionContext) {
  const sanitizer = new AutoCodeSanitizer(context.extensionPath);
  const MAPPING_STATE_KEY = "deepSanitizer.activeMapping";

  // Diff View Provider 등록
  const restoreProvider = new RestorationProvider();
  const providerRegistration =
    vscode.workspace.registerTextDocumentContentProvider(
      "deep-sanitizer-restore",
      restoreProvider,
    );
  context.subscriptions.push(providerRegistration);

  /**
   * 템플릿에 코드와 언어를 주입하는 헬퍼 함수
   */
  const generatePrompt = (
    type: PromptType,
    langId: string,
    code: string,
  ): string => {
    const config = vscode.workspace.getConfiguration("deepSanitizer");
    // 사용자 설정 템플릿이 있으면 우선 사용, 없으면 기본값 사용
    let template =
      config.get<string>(`prompts.${type}`) || DEFAULT_TEMPLATES[type];

    // 플레이스홀더 치환
    return template.replace(/{langId}/g, langId).replace(/{code}/g, code);
  };

  /**
   * 공통 Sanitization 처리 로직
   */
  const processSanitization = async (promptType: PromptType) => {
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
    const fileKey = document.uri.toString();

    const text = selection.isEmpty
      ? document.getText()
      : document.getText(selection);
    const langId = document.languageId;

    const config = vscode.workspace.getConfiguration("deepSanitizer");
    const options = {
      maskVars: config.get<boolean>("maskVariables", true),
      maskFuncs: config.get<boolean>("maskFunctions", true),
      maskClasses: config.get<boolean>("maskClasses", true),
      maskStrings: config.get<boolean>("maskStrings", true),
      removeComments: config.get<boolean>("removeComments", true),
      whitelist: config.get<string[]>("whitelist", []),
      whitelistMode: config.get<string>("whitelistMode", "append") as
        | "append"
        | "overwrite",
      autoCopy: config.get<boolean>("copyToClipboard", true),
    };

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Generating ${promptType} prompt (Secure Mode)...`,
      },
      async () => {
        // 1. Sanitize Code
        const result = await sanitizer.sanitize(text, langId, options);

        // 2. Save Mapping (File-based)
        const globalMappings =
          context.workspaceState.get<Record<string, any>>(MAPPING_STATE_KEY) ||
          {};
        globalMappings[fileKey] = result.mapping;
        await context.workspaceState.update(MAPPING_STATE_KEY, globalMappings);

        // 3. Generate Prompt (Customizable)
        const promptContent = generatePrompt(
          promptType,
          langId,
          result.sanitized,
        );

        // 4. Show Result
        const newDoc = await vscode.workspace.openTextDocument({
          content: promptContent,
          language: "markdown",
        });
        await vscode.window.showTextDocument(newDoc);

        if (options.autoCopy) {
          await vscode.env.clipboard.writeText(promptContent);
          vscode.window.showInformationMessage(
            `Copied ${promptType} prompt! (Mapping saved for restore)`,
          );
        }
      },
    );
  };

  // ---------------------------------------------------------------------------
  // Register Commands
  // ---------------------------------------------------------------------------

  const commandNames: PromptType[] = [
    "refactor",
    "unittest",
    "inspect",
    "flowchart",
  ];
  commandNames.forEach((type) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(`deep-sanitizer.sanitize.${type}`, () =>
        processSanitization(type),
      ),
    );
  });

  // Restore Command (Enhanced with Diff View)
  context.subscriptions.push(
    vscode.commands.registerCommand("deep-sanitizer.restore", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage(
          "Please open an editor containing the code to restore.",
        );
        return;
      }

      const document = editor.document;
      const fileKey = document.uri.toString();
      const globalMappings =
        context.workspaceState.get<Record<string, any>>(MAPPING_STATE_KEY);
      const savedMapping = globalMappings ? globalMappings[fileKey] : undefined;

      if (!savedMapping || Object.keys(savedMapping).length === 0) {
        vscode.window.showErrorMessage(
          "No saved mapping found for this file. Please run a Sanitize command first.",
        );
        return;
      }

      const selection = editor.selection;
      const targetText = selection.isEmpty
        ? document.getText()
        : document.getText(selection);
      const langId = document.languageId;
      const config = vscode.workspace.getConfiguration("deepSanitizer");
      const restoreMode = config.get<string>("restoreMode", "diff");

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Restoring Code...",
          },
          async () => {
            const mappingJson = JSON.stringify(savedMapping);
            const restoredCode = await sanitizer.restoreWithMap(
              targetText,
              mappingJson,
              langId,
            );

            if (restoreMode === "diff") {
              // Mode: Diff View
              // 1. 가상 URI 생성 (쿼리 파라미터에 타임스탬프를 넣어 캐시 방지)
              const uri = vscode.Uri.parse(
                `deep-sanitizer-restore://restore/preview?file=${encodeURIComponent(fileKey)}&t=${Date.now()}`,
              );

              // 2. Provider 업데이트
              restoreProvider.update(uri, restoredCode);

              // 3. Diff Editor 열기 (Left: 현재 에디터 내용, Right: 복원된 내용)
              // 사용자는 여기서 차이를 확인하고 수동으로 복사하거나 파일 내용을 교체할 수 있음
              await vscode.commands.executeCommand(
                "vscode.diff",
                document.uri, // Left
                uri, // Right
                `Sanitized vs Restored (${path.basename(document.fileName)})`,
              );

              vscode.window.showInformationMessage(
                "Opened Diff View. Check the restored code on the right.",
              );
            } else {
              // Mode: Direct Apply (기존 방식)
              await editor.edit((editBuilder) => {
                if (selection.isEmpty) {
                  const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(document.getText().length),
                  );
                  editBuilder.replace(fullRange, restoredCode);
                } else {
                  editBuilder.replace(selection, restoredCode);
                }
              });
              vscode.window.showInformationMessage(
                "Successfully Restored (Direct Applied)!",
              );
            }
          },
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`Restore Failed: ${e.message}`);
      }
    }),
  );
}

export function deactivate() {}
