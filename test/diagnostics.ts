import "reflect-metadata";
import { container } from "tsyringe";
import { URI } from "vscode-uri";
import { ElmWorkspace } from "../src/elmWorkspace";
import * as path from "path";
import { Settings } from "../src/util/settings";
import Parser from "web-tree-sitter";
import { spawnSync } from "child_process";
import { appendFileSync, readFileSync } from "fs";
import { Diagnostic } from "../src/util/types/diagnostics";
import { performance } from "perf_hooks";

container.register("Connection", {
  useValue: {
    console: {
      info: (): void => {
        // console.log(a);
      },
      warn: (): void => {
        // console.log(a);
      },
      error: (a: string): void => {
        console.log(a);
      },
    },
    window: {
      showErrorMessage: (a: string): void => {
        console.log(a);
      },
    },
  },
});

container.register("Settings", {
  useValue: new Settings({} as any, {}),
});

async function initParser(): Promise<void> {
  await Parser.init();
  const absolute = path.join(__dirname, "../tree-sitter-elm.wasm");
  const pathToWasm = path.relative(process.cwd(), absolute);

  const language = await Parser.Language.load(pathToWasm);
  container.registerSingleton("Parser", Parser);
  container.resolve<Parser>("Parser").setLanguage(language);
}

const failed: string[] = [];
const diagnosticTimes = new Map<string, number>();

export async function runDiagnosticTests(uri: string): Promise<void> {
  const pathUri = URI.file(uri);

  try {
    let elmWorkspace = new ElmWorkspace(pathUri);
    await elmWorkspace.init(() => {
      //
    });

    const start = performance.now();
    const diagnostics: Diagnostic[] = [];
    elmWorkspace
      .getForest()
      .treeMap.forEach((treeContainer) =>
        diagnostics.push(
          ...[
            ...elmWorkspace.getSyntacticDiagnostics(treeContainer),
            ...elmWorkspace.getSemanticDiagnostics(treeContainer),
          ].filter(
            (d) =>
              !d.uri.includes("test") &&
              elmWorkspace.getForest().getByUri(d.uri)?.writeable,
          ),
        ),
      );
    diagnosticTimes.set(path.basename(uri), performance.now() - start);

    console.log(`${diagnostics.length} diagnostics found.`);

    diagnostics.forEach((diagnostic) => {
      console.log(`${path.basename(diagnostic.uri)}: ${diagnostic.message}`);
    });

    console.log();

    if (diagnostics.length === 0) {
      // appendFileSync(path.join(__dirname, "complete.txt"), `${uri}\n`);
    } else {
      failed.push(path.basename(uri));
      // process.exitCode = 1;
    }

    elmWorkspace.getForest().treeMap.forEach((sourceFile) => {
      sourceFile.tree.delete();
    });
    elmWorkspace = undefined!;
  } catch (e) {
    console.log(e);
    failed.push(path.basename(uri));
    // process.exitCode = 1;
  }
}

function checkout(repo: string, url: string): void {
  spawnSync("git", ["clone", `https://github.com/${url}`, repo]);

  const cur = process.cwd();
  process.chdir(repo);
  spawnSync("git", ["fetch"]);
  spawnSync("git", ["reset", "--hard", "HEAD"]);
  spawnSync("elm", ["make"]);
  process.chdir(cur);
}

console.log("Getting libs");

const libsToParse = require("../script/search.json") as {
  name: string;
  summary: string;
  license: string;
  version: string;
}[];

const parsingFailures = [
  "niho/json-schema-form",
  "brian-watkins/elm-spec",
  "ggb/elm-trend",
  "indicatrix/elm-chartjs-webcomponent", // comment between case branches
  "blissfully/elm-chartjs-webcomponent",
  "terezka/charts", // Let expr on the same line
  "zwilias/json-decode-exploration", // Weird parsing error in mgold/elm-nonempty-list
];
const compilerFailures = ["mdgriffith/elm-ui", "frandibar/elm-bootstrap"];

const otherFailures = [
  "Chadtech/elm-vector", // Too big
  "arowM/html-extra", // Advanced module resolution bug
];

let completed: string[] = [];

try {
  completed = readFileSync(path.join(__dirname, "complete.txt"))
    .toString()
    .split("\n");
} catch (e) {
  //
}

const filteredLibs = libsToParse
  .map((lib) => lib.name)
  .filter(
    (lib) =>
      !lib.startsWith("elm/") &&
      !lib.startsWith("elm-explorations/") &&
      !otherFailures.includes(lib) &&
      // !parsingFailures.includes(lib) &&
      !compilerFailures.includes(lib) &&
      !completed.includes(path.join(__dirname, "../", `examples-full/${lib}`)),
  );

console.log("Getting applications");

const applications = require("../script/applications.json") as string[];

async function testAll(): Promise<void> {
  await initParser();

  for (const lib of [...applications, ...filteredLibs]) {
    console.log(lib);
    const dir = `examples-full/${lib}`;

    try {
      checkout(dir, lib);

      await runDiagnosticTests(path.join(__dirname, "../", dir));
    } catch (e) {
      console.log(e);
    } finally {
      if (global.gc) {
        global.gc();
      }
    }
  }

  console.log("FAILURES");
  failed.forEach((fail) => console.log(fail));

  console.log("TOP TEN TIMES");
  Array.from(diagnosticTimes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([uri, time]) => {
      console.log(`${uri}: ${time.toFixed(0)}ms`);
    });
}

process.on("uncaughtException", function (err) {
  console.log(`Caught exception: ${err}`);
});

void testAll();