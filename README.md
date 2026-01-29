# Deep Sanitizer

Deep Sanitizer is a secure code sanitization tool for developers using AI (LLM).
It obfuscates sensitive business logic (variable names, function names) while preserving external libraries and language keywords.

## Features

- **Smart Context Awareness**: Automatically detects and preserves external libraries (e.g., React, console, standard APIs).
- **Local Security**: All processing is done locally on your machine. No code leaves your computer.
- **Language Support**: Supports TypeScript, JavaScript, Python, TSX, and more via Tree-sitter.
- **Customizable**: Toggle masking for variables, functions, or classes via settings.

## Usage

1. Open a code file.
2. Run command `Deep Sanitizer: Sanitize Code`.
3. The sanitized code will open in a new tab (and automatically copy to clipboard if enabled).
