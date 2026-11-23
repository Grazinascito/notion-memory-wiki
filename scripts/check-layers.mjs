#!/usr/bin/env node
/**
 * Static Layer Dependency Rule checker (DESIGN-DOC.md Section 2.5).
 * Enforces inward-only imports across src/cli, src/core, src/infra, and src/shared.
 */
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(process.cwd(), "src");
const violations = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.isFile() && full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const IMPORT_RE = /^\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT_RE = /import\(\s*["']([^"']+)["']\s*\)/g;

function extractSpecifiers(content) {
  const specs = [];
  for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      specs.push(m[1]);
    }
  }
  return specs;
}

function resolveLayer(fromFile, spec) {
  if (spec.startsWith("node:")) return { kind: "node", spec };
  if (!spec.startsWith(".")) return { kind: "external", spec };
  const resolved = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ".ts"));
  const rel = path.relative(rootDir, resolved);
  const parts = rel.split(path.sep);
  return { kind: "local", layer: parts[0], rel };
}

for (const file of walk(rootDir)) {
  const relFile = path.relative(rootDir, file);
  const layer = relFile.split(path.sep)[0];
  const infraAdapter = layer === "infra" ? relFile.split(path.sep)[1] : null;
  const content = fs.readFileSync(file, "utf8");
  const specs = extractSpecifiers(content);

  if (layer === "core") {
    // Check forbidden global fetch usage inside src/core/
    if (/\bfetch\s*\(/.test(content)) {
      violations.push(`${relFile}: src/core/ forbids calling global fetch() directly`);
    }
  }

  for (const spec of specs) {
    const target = resolveLayer(file, spec);
    const isNodeFs = target.kind === "node" && (target.spec === "node:fs" || target.spec.startsWith("node:fs/"));

    if (layer === "shared") {
      if (target.kind === "local" && target.layer !== "shared") {
        violations.push(`${relFile}: src/shared/ may only import src/shared/ (found ${spec})`);
      }
      if (isNodeFs) {
        violations.push(`${relFile}: src/shared/ forbids node:fs and node:fs/* (found ${spec})`);
      }
    }

    if (layer === "core") {
      if (isNodeFs) {
        violations.push(`${relFile}: src/core/ forbids node:fs and node:fs/* (found ${spec})`);
      }
      if (target.kind === "local" && target.layer !== "core" && target.layer !== "shared") {
        violations.push(`${relFile}: src/core/ may only import src/core/ and src/shared/ (found ${spec})`);
      }
    }

    if (layer === "infra") {
      if (target.kind === "local") {
        const normalizedRel = target.rel.split(path.sep).join("/");
        const sameAdapter =
          infraAdapter !== null && normalizedRel.startsWith(`infra/${infraAdapter}/`);
        const sharedPosixFs = normalizedRel.startsWith("infra/fs/");
        const allowed =
          target.layer === "shared" ||
          normalizedRel === "core/ports.ts" ||
          sameAdapter ||
          sharedPosixFs;
        if (!allowed) {
          violations.push(
            `${relFile}: src/infra/${infraAdapter}/ may only import src/core/ports.ts, src/shared/, src/infra/fs/, or its own adapter dir (found ${spec})`,
          );
        }
      }
    }

    if (layer === "cli") {
      const isBootstrap = relFile === path.join("cli", "bootstrap.ts");
      if (!isBootstrap && target.kind === "local" && target.layer === "infra") {
        violations.push(
          `${relFile}: src/cli/ forbids importing src/infra/ outside src/cli/bootstrap.ts (found ${spec})`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Layer dependency check FAILED:");
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

console.log("Layer dependency check passed.");
