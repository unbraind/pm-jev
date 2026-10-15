import { readFileSync, statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import { VISITOR_KEYS } from "@babel/types";
import type { Node } from "@babel/types";

/** One undocumented function or export, identified without including source content. */
export interface FunctionDocViolation {
  /** Repository-relative source location. */
  readonly file: string;
  /** Declaration line reported by the full TypeScript parser. */
  readonly line: number;
  /** Stable label compatible with the fleet report formatter. */
  readonly symbol: string;
  /** Actionable gate failure explanation. */
  readonly reason: string;
}

/** Audit all functions, including short helpers and callbacks, with a full syntax tree. */
export async function auditFunctionDocs(root: string): Promise<{ checked: number; violations: FunctionDocViolation[] }> {
  const files = glob("**/*.{ts,tsx}", { cwd: root, exclude: ["node_modules/**", "dist/**", "dist-test/**", "coverage/**", "test/**", "tests/**", ".agents/**", ".git/**", "**/.*", "**/.*/**"] });
  const violations: FunctionDocViolation[] = [];
  let checked = 0;
  for await (const entry of files) {
    const file = join(root, entry);
    // A directory can match "*.ts" (for example fixtures.ts/); only regular files are parsed.
    if (!statSync(file).isFile()) continue;
    const tree = parse(readFileSync(file, "utf8"), { sourceType: "module", plugins: ["typescript", "jsx"] });
    /** Visit parser-owned child nodes and judge function and export documentation. */
    function visit(node: Node, parents: readonly Node[]): void {
      const isFunction = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ClassMethod", "ObjectMethod"].includes(node.type);
      const isExport = node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration";
      if (isFunction || isExport) {
        checked += 1;
        const candidates = [node];
        for (const parent of [...parents].reverse()) {
          if (!["ExportNamedDeclaration", "ExportDefaultDeclaration", "VariableDeclarator", "VariableDeclaration", "ObjectProperty"].includes(parent.type)) break;
          candidates.push(parent);
        }
        /** Accept a meaningful JSDoc attached to the declaration or its immediate wrapper. */
        const documented = candidates.some(/** Check only the declaration and its immediate wrappers. */ candidate => candidate.leadingComments?.some(/** Require a substantive block docstring. */ comment => comment.type === "CommentBlock" && comment.value.startsWith("*") && comment.value.trim().length > 10));
        if (!documented) {
          const symbol = "id" in node && node.id && "name" in node.id ? String(node.id.name) : node.type;
          violations.push({ file: relative(root, file), line: node.loc!.start.line, symbol, reason: "Every function and export needs a meaningful JSDoc." });
        }
      }
      for (const key of VISITOR_KEYS[node.type]) {
        const value: unknown = (node as unknown as Record<string, unknown>)[key];
        if (Array.isArray(value)) {
          for (const child of value) { if (child) visit(child as Node, [...parents, node]); }
        } else if (value) visit(value as Node, [...parents, node]);
      }
    }
    visit(tree, []);
  }
  return { checked, violations };
}
