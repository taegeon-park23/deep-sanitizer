import * as vscode from "vscode";
import { AutoCodeSanitizer } from "./sanitizer";

export function activate(context: vscode.ExtensionContext) {
  const sanitizer = new AutoCodeSanitizer(context.extensionPath);

  // Key for storing mapping state
  const MAPPING_STATE_KEY = "deepSanitizer.activeMapping";

  // 1. Sanitize Command
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

      // Fix: Access real properties 'document' and 'selection'
      const document = editor.document;
      const selection = editor.selection;

      const text = selection.isEmpty
        ? document.getText()
        : document.getText(selection);
      const langId = document.languageId;

      // Configuration Load
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
          title: "Processing Security Sanitization...",
        },
        async () => {
          // Execute Sanitize
          const result = await sanitizer.sanitize(text, langId, options);

          // Update State (Internal Storage)
          await context.workspaceState.update(
            MAPPING_STATE_KEY,
            result.mapping,
          );

          // Construct Prompt
          const outputTemplate = `prompt:
\`\`\`txt
You are an expert developer. Refactor code or generate unit tests based on the code below.
IMPORTANT: The code is sanitized for security. 
1. Analyze the logic flow based on the structure.
2. KEEP the sanitized variable names (e.g., VAR_1, ACTION_1) EXACTLY as they are. 
3. DO NOT attempt to de-obfuscate or guess original names.
4. If you create NEW variables, use meaningful names.
5. Return ONLY the code block.
\`\`\`

code
\`\`\`${langId}
${result.sanitized}
\`\`\``;

          // Open in new window
          const newDoc = await vscode.workspace.openTextDocument({
            content: outputTemplate,
            language: "markdown",
          });
          await vscode.window.showTextDocument(newDoc);

          if (options.autoCopy) {
            await vscode.env.clipboard.writeText(outputTemplate);
            vscode.window.showInformationMessage(
              "Copied to clipboard! (Mapping info saved internally)",
            );
          }
        },
      );
    },
  );

  // 2. Restore Command
  const restoreDisposable = vscode.commands.registerCommand(
    "deep-sanitizer.restore",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage(
          "Please open an editor containing the code to restore.",
        );
        return;
      }

      // Retrieve Mapping
      const savedMapping = context.workspaceState.get<any>(MAPPING_STATE_KEY);

      if (!savedMapping || Object.keys(savedMapping).length === 0) {
        vscode.window.showErrorMessage(
          "No saved mapping found. Please run 'Sanitize Code' first.",
        );
        return;
      }

      // Fix: Access real properties
      const document = editor.document;
      const selection = editor.selection;

      const targetText = selection.isEmpty
        ? document.getText()
        : document.getText(selection);

      const langId = document.languageId;

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Restoring Code...",
          },
          async () => {
            // Convert to JSON string as expected by current sanitizer implementation
            const mappingJson = JSON.stringify(savedMapping);

            // Execute Restore
            const restoredCode = await sanitizer.restoreWithMap(
              targetText,
              mappingJson,
              langId,
            );

            // Apply Edits
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

            vscode.window.showInformationMessage("Successfully Restored!");
          },
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`Restore Failed: ${e.message}`);
      }
    },
  );

  context.subscriptions.push(sanitizeDisposable);
  context.subscriptions.push(restoreDisposable);
}

export function deactivate() {}
