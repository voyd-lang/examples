"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const defaultOutputDir = path.join(rootDir, "output", "benchmark_compare");

const defaultConfig = {
  iterations: parsePositiveInt(process.env.BENCH_SAMPLES, 1),
  warmupRuns: parsePositiveInt(process.env.BENCH_WARMUP, 0),
  outputDir: defaultOutputDir,
  skip: new Set(),
  pythonBin: process.env.BENCH_PYTHON_BIN || null,
  rustcBin: process.env.BENCH_RUSTC_BIN || null,
  swiftcBin: process.env.BENCH_SWIFTC_BIN || null,
  goBin: process.env.BENCH_GO_BIN || null,
  javaBin: process.env.BENCH_JAVA_BIN || null,
  javacBin: process.env.BENCH_JAVAC_BIN || null,
  tscBin:
    process.env.BENCH_TSC_BIN ||
    path.join(rootDir, "node_modules", ".bin", "tsc"),
  vtBin:
    process.env.BENCH_VT_BIN ||
    path.join(rootDir, "node_modules", ".bin", "voyd"),
  matrixSize: parsePositiveInt(process.env.BENCH_MATRIX_SIZE, 8),
  matrixRounds: parsePositiveInt(process.env.BENCH_MATRIX_ROUNDS, 2),
  logLines: parsePositiveInt(process.env.BENCH_LOG_LINES, 1),
  logRounds: parsePositiveInt(process.env.BENCH_LOG_ROUNDS, 1),
  topN: parsePositiveInt(process.env.BENCH_TOP_N, 5),
};

const sourcePaths = {
  ts: path.join(rootDir, "dist", "benchmarks", "suite", "ts", "benchmarks.js"),
  py: path.join(rootDir, "benchmarks", "suite", "py", "benchmarks.py"),
  rust: path.join(rootDir, "benchmarks", "suite", "rust", "benchmarks.rs"),
  swift: path.join(rootDir, "benchmarks", "suite", "swift", "benchmarks.swift"),
  go: path.join(rootDir, "benchmarks", "suite", "go", "benchmarks.go"),
  java: path.join(rootDir, "benchmarks", "suite", "java", "Benchmarks.java"),
  voyd: path.join(rootDir, "benchmarks", "suite", "voyd", "benchmarks.voyd"),
};

function parsePositiveInt(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/benchmark-compare.js [options]

Options:
  --iterations <n>        Timed samples per benchmark.
  --warmup-runs <n>       Warmup runs inside each process.
  --skip <langs>          Comma-separated or repeatable skip list.
                          Supported values: voyd, typescript, python, rust, swift, go, java
  --output-dir <path>     Directory for compiled artifacts and results.
  --matrix-size <n>       Dense matrix size for compute benchmark.
  --matrix-rounds <n>     Matrix multiply rounds per sample.
  --log-lines <n>         Synthetic log lines for practical benchmark.
  --log-rounds <n>        Log parsing rounds per sample.
  --top-n <n>             Number of top aggregates to include in summaries.
  --python-bin <path>     Python interpreter path.
  --rustc-bin <path>      rustc path.
  --swiftc-bin <path>     swiftc path.
  --go-bin <path>         Go tool path.
  --java-bin <path>       Java runtime path.
  --javac-bin <path>      javac path.
  --tsc-bin <path>        TypeScript compiler path.
  --vt-bin <path>         Voyd CLI path.
  --help                  Show this help text.
`);
}

function normalizeLanguageName(value) {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "ts":
    case "node":
      return "typescript";
    case "py":
    case "python3":
      return "python";
    default:
      return normalized;
  }
}

function parseCli(argv) {
  const cli = {
    ...defaultConfig,
    skip: new Set(defaultConfig.skip),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg === "--iterations" && next !== undefined) {
      cli.iterations = parsePositiveInt(next, cli.iterations);
      index += 1;
    } else if (arg === "--warmup-runs" && next !== undefined) {
      cli.warmupRuns = parsePositiveInt(next, cli.warmupRuns);
      index += 1;
    } else if (arg === "--skip" && next !== undefined) {
      for (const item of next.split(",")) {
        if (item.trim()) {
          cli.skip.add(normalizeLanguageName(item));
        }
      }
      index += 1;
    } else if (arg === "--output-dir" && next !== undefined) {
      cli.outputDir = path.resolve(rootDir, next);
      index += 1;
    } else if (arg === "--matrix-size" && next !== undefined) {
      cli.matrixSize = parsePositiveInt(next, cli.matrixSize);
      index += 1;
    } else if (arg === "--matrix-rounds" && next !== undefined) {
      cli.matrixRounds = parsePositiveInt(next, cli.matrixRounds);
      index += 1;
    } else if (arg === "--log-lines" && next !== undefined) {
      cli.logLines = parsePositiveInt(next, cli.logLines);
      index += 1;
    } else if (arg === "--log-rounds" && next !== undefined) {
      cli.logRounds = parsePositiveInt(next, cli.logRounds);
      index += 1;
    } else if (arg === "--top-n" && next !== undefined) {
      cli.topN = parsePositiveInt(next, cli.topN);
      index += 1;
    } else if (arg === "--python-bin" && next !== undefined) {
      cli.pythonBin = next;
      index += 1;
    } else if (arg === "--rustc-bin" && next !== undefined) {
      cli.rustcBin = next;
      index += 1;
    } else if (arg === "--swiftc-bin" && next !== undefined) {
      cli.swiftcBin = next;
      index += 1;
    } else if (arg === "--go-bin" && next !== undefined) {
      cli.goBin = next;
      index += 1;
    } else if (arg === "--java-bin" && next !== undefined) {
      cli.javaBin = next;
      index += 1;
    } else if (arg === "--javac-bin" && next !== undefined) {
      cli.javacBin = next;
      index += 1;
    } else if (arg === "--tsc-bin" && next !== undefined) {
      cli.tscBin = next;
      index += 1;
    } else if (arg === "--vt-bin" && next !== undefined) {
      cli.vtBin = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return cli;
}

function resolveExecutable(candidates, probeArgs, errorMessage) {
  for (const candidate of candidates.filter(Boolean)) {
    const result = spawnSync(candidate, probeArgs, {
      cwd: rootDir,
      encoding: null,
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (result.status === 0) {
      return candidate;
    }
  }
  throw new Error(errorMessage);
}

function resolvePythonBin(explicitBin) {
  return resolveExecutable(
    [explicitBin, "python3", "python"],
    ["--version"],
    "Unable to find a Python interpreter. Pass --python-bin or set BENCH_PYTHON_BIN.",
  );
}

function resolveRustcBin(explicitBin) {
  return resolveExecutable(
    [explicitBin, "rustc"],
    ["--version"],
    "Unable to find rustc. Pass --rustc-bin or set BENCH_RUSTC_BIN.",
  );
}

function resolveSwiftcBin(explicitBin) {
  return resolveExecutable(
    [explicitBin, "swiftc"],
    ["--version"],
    "Unable to find swiftc. Pass --swiftc-bin or set BENCH_SWIFTC_BIN.",
  );
}

function resolveGoBin(explicitBin) {
  return resolveExecutable(
    [explicitBin, "go"],
    ["version"],
    "Unable to find go. Pass --go-bin or set BENCH_GO_BIN.",
  );
}

function resolveJavacBin(explicitBin) {
  return resolveExecutable(
    [
      explicitBin,
      "javac",
      "/opt/homebrew/opt/openjdk/bin/javac",
      "/opt/homebrew/opt/openjdk@21/bin/javac",
      "/opt/homebrew/opt/openjdk@25/bin/javac",
    ],
    ["-version"],
    "Unable to find javac. Pass --javac-bin or install a JDK.",
  );
}

function resolveJavaBin(explicitBin) {
  return resolveExecutable(
    [
      explicitBin,
      "java",
      "/opt/homebrew/opt/openjdk/bin/java",
      "/opt/homebrew/opt/openjdk@21/bin/java",
      "/opt/homebrew/opt/openjdk@25/bin/java",
    ],
    ["-version"],
    "Unable to find java. Pass --java-bin or install a JDK.",
  );
}

function measure(command, args, options = {}) {
  const { env, captureStdout = false } = options;
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: null,
    stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString("utf8") : "";
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${stderr}`);
  }
  return {
    elapsedMs,
    stdout: captureStdout ? (result.stdout ?? Buffer.alloc(0)) : Buffer.alloc(0),
  };
}

function summarize(samples) {
  const total = samples.reduce((sum, sample) => sum + sample, 0);
  return {
    iterations: samples.length,
    averageMs: total / samples.length,
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
  };
}

function parseRunOutput(stdout) {
  const lines = stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const resultLine = lines.find((line) => line.startsWith("RESULT:"));
  if (resultLine) {
    const payload = resultLine.slice("RESULT:".length);
    const separatorIndex = payload.indexOf("\t");
    if (separatorIndex < 0) {
      throw new Error(`Unexpected RESULT benchmark output:\n${stdout}`);
    }
    return {
      summary: payload.slice(0, separatorIndex),
      samplesMs: payload
        .slice(separatorIndex + 1)
        .split(",")
        .filter(Boolean)
        .map((value) => Number.parseFloat(value)),
    };
  }
  const summaryLine = lines.find((line) => line.startsWith("SUMMARY:"));
  const samplesLine = lines.find((line) => line.startsWith("SAMPLES_MS:"));
  if (!summaryLine || !samplesLine) {
    throw new Error(`Unexpected benchmark output:\n${stdout}`);
  }
  return {
    summary: summaryLine.slice("SUMMARY:".length),
    samplesMs: samplesLine
      .slice("SAMPLES_MS:".length)
      .split(",")
      .filter(Boolean)
      .map((value) => Number.parseFloat(value)),
  };
}

function buildEnv(cli, benchmarkName) {
  return {
    BENCH_NAME: benchmarkName,
    BENCH_IS_LOG: benchmarkName === "log" ? "1" : "0",
    BENCH_SAMPLES: String(cli.iterations),
    BENCH_WARMUP: String(cli.warmupRuns),
    BENCH_MATRIX_SIZE: String(cli.matrixSize),
    BENCH_MATRIX_ROUNDS: String(cli.matrixRounds),
    BENCH_LOG_LINES: String(cli.logLines),
    BENCH_LOG_ROUNDS: String(cli.logRounds),
    BENCH_TOP_N: String(cli.topN),
  };
}

async function runVoydBenchmark({ wasmPath, benchmarkName, iterations, warmupRuns }) {
  const { createVoydHost } = await import(
    pathToFileURL(
      path.resolve(rootDir, "../voyd/packages/js-host/dist/index.js"),
    ).href
  );
  const wasm = new Uint8Array(fs.readFileSync(wasmPath));
  const host = await createVoydHost({ wasm });
  const entryName = benchmarkName === "log" ? "log" : "compute";

  let summary = "";
  for (let index = 0; index < warmupRuns; index += 1) {
    summary = String(await host.runPure(entryName, []));
  }

  const samplesMs = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = process.hrtime.bigint();
    summary = String(await host.runPure(entryName, []));
    samplesMs.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }

  return { summary, samplesMs };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const warnings = [];
  const outputDir = cli.outputDir;
  const buildDir = path.join(outputDir, "build");
  const javaClassesDir = path.join(buildDir, "java");
  const paths = {
    rustBinary: path.join(buildDir, "suite_rust"),
    swiftBinary: path.join(buildDir, "suite_swift"),
    goBinary: path.join(buildDir, "suite_go"),
    voydWasm: path.join(buildDir, "suite_voyd.wasm"),
  };

  fs.mkdirSync(buildDir, { recursive: true });

  const pythonBin = cli.skip.has("python") ? null : resolvePythonBin(cli.pythonBin);
  const rustcBin = cli.skip.has("rust") ? null : resolveRustcBin(cli.rustcBin);
  const swiftcBin = cli.skip.has("swift") ? null : resolveSwiftcBin(cli.swiftcBin);
  const goBin = cli.skip.has("go") ? null : resolveGoBin(cli.goBin);

  let javaBin = null;
  let javacBin = null;
  if (!cli.skip.has("java")) {
    try {
      javacBin = resolveJavacBin(cli.javacBin);
      javaBin = resolveJavaBin(cli.javaBin);
    } catch (error) {
      warnings.push(String(error instanceof Error ? error.message : error));
      javaBin = null;
      javacBin = null;
    }
  }

  const compile = {};

  if (!cli.skip.has("typescript")) {
    process.stderr.write("Compiling TypeScript benchmark\n");
    compile.typeScriptTscMs = measure(cli.tscBin, ["-p", "tsconfig.json"]).elapsedMs;
  } else {
    compile.typeScriptTscMs = null;
  }

  if (rustcBin) {
    process.stderr.write("Compiling Rust benchmark\n");
    compile.rustcMs = measure(rustcBin, ["-O", "-o", paths.rustBinary, sourcePaths.rust]).elapsedMs;
  } else {
    compile.rustcMs = null;
  }

  if (swiftcBin) {
    process.stderr.write("Compiling Swift benchmark\n");
    compile.swiftcMs = measure(swiftcBin, ["-O", "-o", paths.swiftBinary, sourcePaths.swift]).elapsedMs;
  } else {
    compile.swiftcMs = null;
  }

  if (goBin) {
    process.stderr.write("Compiling Go benchmark\n");
    compile.goBuildMs = measure(goBin, ["build", "-o", paths.goBinary, sourcePaths.go]).elapsedMs;
  } else {
    compile.goBuildMs = null;
  }

  if (javacBin && javaBin) {
    process.stderr.write("Compiling Java benchmark\n");
    fs.rmSync(javaClassesDir, { recursive: true, force: true });
    fs.mkdirSync(javaClassesDir, { recursive: true });
    compile.javacMs = measure(javacBin, ["-d", javaClassesDir, sourcePaths.java]).elapsedMs;
  } else {
    compile.javacMs = null;
  }

  if (!cli.skip.has("voyd")) {
    process.stderr.write("Emitting Voyd wasm benchmark\n");
    const emit = measure(cli.vtBin, ["--emit-wasm", "--opt", sourcePaths.voyd], {
      captureStdout: true,
    });
    compile.voydEmitWasmMs = emit.elapsedMs;
    fs.writeFileSync(paths.voydWasm, emit.stdout);
  } else {
    compile.voydEmitWasmMs = null;
  }

  const runners = {
    voyd: cli.skip.has("voyd") ? null : true,
    typescript: cli.skip.has("typescript")
      ? null
      : (benchmarkName) =>
          measure(process.execPath, [sourcePaths.ts], {
            captureStdout: true,
            env: buildEnv(cli, benchmarkName),
          }).stdout.toString("utf8"),
    python: pythonBin
      ? (benchmarkName) =>
          measure(pythonBin, [sourcePaths.py], {
            captureStdout: true,
            env: buildEnv(cli, benchmarkName),
          }).stdout.toString("utf8")
      : null,
    rust: rustcBin
      ? (benchmarkName) =>
          measure(paths.rustBinary, [], {
            captureStdout: true,
            env: buildEnv(cli, benchmarkName),
          }).stdout.toString("utf8")
      : null,
    swift: swiftcBin
      ? (benchmarkName) =>
          measure(paths.swiftBinary, [], {
            captureStdout: true,
            env: buildEnv(cli, benchmarkName),
          }).stdout.toString("utf8")
      : null,
    go: goBin
      ? (benchmarkName) =>
          measure(paths.goBinary, [], {
            captureStdout: true,
            env: buildEnv(cli, benchmarkName),
          }).stdout.toString("utf8")
      : null,
    java: javaBin && javacBin
      ? (benchmarkName) =>
          measure(javaBin, ["-cp", javaClassesDir, "Benchmarks"], {
            captureStdout: true,
            env: buildEnv(cli, benchmarkName),
          }).stdout.toString("utf8")
      : null,
  };

  const benchmarkResults = {};
  for (const benchmarkName of ["compute", "log"]) {
    process.stderr.write(`Running ${benchmarkName} benchmark\n`);
    const perLanguage = {};
    let expectedSummary = null;
    for (const [language, run] of Object.entries(runners)) {
      if (!run) {
        perLanguage[language] = null;
        continue;
      }
      const parsed =
        language === "voyd"
          ? await runVoydBenchmark({
              wasmPath: paths.voydWasm,
              benchmarkName,
              iterations: cli.iterations,
              warmupRuns: cli.warmupRuns,
            })
          : parseRunOutput(run(benchmarkName));
      const comparableSummary = parsed.summary;
      if (expectedSummary === null) {
        expectedSummary = comparableSummary;
      } else if (comparableSummary !== expectedSummary) {
        throw new Error(
          `Summary mismatch for ${benchmarkName}/${language}\nexpected: ${expectedSummary}\nactual:   ${comparableSummary}`,
        );
      }
      perLanguage[language] = {
        summary: parsed.summary,
        comparableSummary,
        samplesMs: parsed.samplesMs,
        stats: summarize(parsed.samplesMs),
      };
    }
    benchmarkResults[benchmarkName] = {
      summary: expectedSummary,
      languages: perLanguage,
    };
  }

  const results = {
    generatedAt: new Date().toISOString(),
    fairness: [
      "Compilation happens once before measurement.",
      "Each benchmark measures itself inside the target process/runtime.",
      "Process startup, Voyd CLI startup, wasm file loading, and output file writes are excluded from timed samples.",
    ],
    config: {
      iterations: cli.iterations,
      warmupRuns: cli.warmupRuns,
      matrixSize: cli.matrixSize,
      matrixRounds: cli.matrixRounds,
      logLines: cli.logLines,
      logRounds: cli.logRounds,
      topN: cli.topN,
      skipped: Array.from(cli.skip).sort(),
    },
    compile,
    benchmarks: benchmarkResults,
    warnings,
  };

  const resultsPath = path.join(outputDir, "results.json");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error instanceof Error ? error.stack ?? error.message : error)}\n`);
  process.exitCode = 1;
});
