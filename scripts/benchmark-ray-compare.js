"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const defaultOutputDir = path.join(rootDir, "output", "benchmark_ray_compare");
const defaultIterations = parsePositiveInt(
  process.env.VTRACE_BENCH_ITERATIONS,
  3,
);
const defaultWarmupRuns = parsePositiveInt(process.env.VTRACE_BENCH_WARMUP, 1);

const defaultConfig = {
  iterations: defaultIterations,
  warmupRuns: defaultWarmupRuns,
  keepImages: false,
  outputDir: defaultOutputDir,
  skip: new Set(),
  pythonBin: process.env.VTRACE_PYTHON_BIN || null,
  rustcBin: process.env.VTRACE_RUSTC_BIN || null,
  swiftcBin: process.env.VTRACE_SWIFTC_BIN || null,
  goBin: process.env.VTRACE_GO_BIN || null,
  javaBin: process.env.VTRACE_JAVA_BIN || null,
  javacBin: process.env.VTRACE_JAVAC_BIN || null,
  tscBin:
    process.env.VTRACE_TSC_BIN ||
    path.join(rootDir, "node_modules", ".bin", "tsc"),
  vtBin:
    process.env.VTRACE_VT_BIN ||
    path.join(rootDir, "node_modules", ".bin", "voyd"),
};

if (process.env.VTRACE_SKIP_PYTHON === "1") {
  defaultConfig.skip.add("python");
}

const sourcePaths = {
  tsRenderer: path.join(
    rootDir,
    "dist",
    "benchmarks",
    "ray",
    "ts",
    "vtrace.js",
  ),
  pyRenderer: path.join(rootDir, "benchmarks", "ray", "py", "vtrace.py"),
  rustRenderer: path.join(rootDir, "benchmarks", "ray", "rust", "vtrace.rs"),
  swiftRenderer: path.join(
    rootDir,
    "benchmarks",
    "ray",
    "swift",
    "vtrace.swift",
  ),
  goRenderer: path.join(rootDir, "benchmarks", "ray", "go", "vtrace.go"),
  javaRenderer: path.join(rootDir, "benchmarks", "ray", "java", "VTrace.java"),
  voydBaselineEntry: path.join(
    rootDir,
    "benchmarks",
    "ray",
    "voyd",
    "vtrace_baseline.voyd",
  ),
  voydTunedEntry: path.join(
    rootDir,
    "benchmarks",
    "ray",
    "voyd",
    "vtrace_tuned.voyd",
  ),
};

function parsePositiveInt(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/benchmark-ray-compare.js [options]

Options:
  --iterations <n>      Number of timed samples per benchmark.
  --warmup-runs <n>     Number of warmup runs before sampling.
  --skip <langs>        Comma-separated or repeatable skip list. Supported values:
                        baseline, tuned, typescript, python, rust, swift, go, java
  --keep-images         Keep the last rendered PPM for each benchmark.
  --output-dir <path>   Directory for benchmark outputs.
  --python-bin <path>   Python interpreter path.
  --rustc-bin <path>    Rust compiler path.
  --swiftc-bin <path>   Swift compiler path.
  --go-bin <path>       Go tool path.
  --java-bin <path>     Java runtime path.
  --javac-bin <path>    Java compiler path.
  --tsc-bin <path>      TypeScript compiler path.
  --vt-bin <path>       Voyd CLI path.
  --help                Show this help text.

Environment fallback:
  VTRACE_BENCH_ITERATIONS
  VTRACE_BENCH_WARMUP
  VTRACE_SKIP_PYTHON
  VTRACE_PYTHON_BIN
  VTRACE_RUSTC_BIN
  VTRACE_SWIFTC_BIN
`);
}

function normalizeLanguageName(value) {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "voyd-baseline":
    case "baseline-voyd":
    case "baseline":
      return "baseline";
    case "voyd-tuned":
    case "voyd-fast":
    case "tuned-voyd":
    case "fast-voyd":
    case "tuned":
    case "fast":
      return "tuned";
    case "typescript":
    case "ts":
    case "node":
      return "typescript";
    case "python":
    case "python3":
    case "py":
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
    } else if (arg === "--keep-images") {
      cli.keepImages = true;
    } else if (arg === "--output-dir" && next !== undefined) {
      cli.outputDir = path.resolve(rootDir, next);
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
    "Unable to find a Python interpreter. Set VTRACE_PYTHON_BIN or pass --python-bin.",
  );
}

function resolveRustcBin(explicitBin) {
  return resolveExecutable(
    [explicitBin, "rustc"],
    ["--version"],
    "Unable to find rustc. Set VTRACE_RUSTC_BIN or pass --rustc-bin.",
  );
}

function resolveSwiftcBin(explicitBin) {
  return resolveExecutable(
    [explicitBin, "swiftc"],
    ["--version"],
    "Unable to find swiftc. Set VTRACE_SWIFTC_BIN or pass --swiftc-bin.",
  );
}

function resolveGoBin(explicitBin) {
  return resolveExecutable(
    [explicitBin, "go"],
    ["version"],
    "Unable to find go. Pass --go-bin or install Go.",
  );
}

function resolveJavacBin(explicitBin) {
  return resolveExecutable(
    [
      explicitBin,
      "javac",
      "/opt/homebrew/opt/openjdk/bin/javac",
      "/opt/homebrew/opt/openjdk@21/bin/javac",
      "/usr/local/opt/openjdk/bin/javac",
      "/usr/local/opt/openjdk@21/bin/javac",
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
      "/usr/local/opt/openjdk/bin/java",
      "/usr/local/opt/openjdk@21/bin/java",
    ],
    ["-version"],
    "Unable to find java. Pass --java-bin or install a JDK.",
  );
}

function measure(command, args, options = {}) {
  const { captureStdout = false, stdoutFilePath, ...spawnOptions } = options;
  let stdoutHandle = null;
  let stdio = ["ignore", captureStdout ? "pipe" : "ignore", "pipe"];

  if (stdoutFilePath) {
    fs.mkdirSync(path.dirname(stdoutFilePath), { recursive: true });
    stdoutHandle = fs.openSync(stdoutFilePath, "w");
    stdio = ["ignore", stdoutHandle, "pipe"];
  }

  const startedAt = process.hrtime.bigint();
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: rootDir,
      encoding: null,
      stdio,
      ...spawnOptions,
    });
  } finally {
    if (stdoutHandle !== null) {
      fs.closeSync(stdoutHandle);
    }
  }

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
    stdout: captureStdout
      ? (result.stdout ?? Buffer.alloc(0))
      : Buffer.alloc(0),
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

function warmup(label, count, run) {
  for (let index = 0; index < count; index += 1) {
    process.stderr.write(`Warmup ${label} ${index + 1}/${count}\n`);
    run();
  }
}

function sample(label, count, run) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    process.stderr.write(`Benchmark ${label} ${index + 1}/${count}\n`);
    samples.push(run());
  }
  return summarize(samples);
}

function upperFirst(value) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function buildRelativeSpeed(runResults) {
  const populated = Object.entries(runResults).filter(
    ([, stats]) => stats && typeof stats.averageMs === "number",
  );
  const result = {};
  for (const [lhsKey, lhsStats] of populated) {
    for (const [rhsKey, rhsStats] of populated) {
      if (lhsKey === rhsKey) {
        continue;
      }
      result[`${lhsKey}Vs${upperFirst(rhsKey)}`] =
        lhsStats.averageMs / rhsStats.averageMs;
    }
  }
  return result;
}

function imagePathFor(outputDir, slug) {
  return path.join(outputDir, "images", `${slug}.ppm`);
}

function removeIfPresent(filePath) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function benchmarkLanguage({
  label,
  imagePath,
  keepImages,
  iterations,
  warmupRuns,
  run,
}) {
  warmup(label, warmupRuns, () => run(imagePath));
  const stats = sample(label, iterations, () => run(imagePath));
  if (!keepImages) {
    removeIfPresent(imagePath);
  }
  return stats;
}

function safeStatSize(filePath) {
  return fs.existsSync(filePath) ? fs.statSync(filePath).size : null;
}

function main() {
  const cli = parseCli(process.argv.slice(2));
  const warnings = [];

  const outputDir = cli.outputDir;
  const buildDir = path.join(outputDir, "build");
  const javaClassesDir = path.join(buildDir, "java");
  const paths = {
    voydBaselineWasm: path.join(outputDir, "voyd_baseline.wasm"),
    voydTunedWasm: path.join(outputDir, "voyd_tuned.wasm"),
    rustBinary: path.join(outputDir, "vtrace_rust"),
    swiftBinary: path.join(outputDir, "vtrace_swift"),
    goBinary: path.join(outputDir, "vtrace_go"),
    images: {
      voydBaselineWasm: imagePathFor(outputDir, "voyd-baseline"),
      voydTunedWasm: imagePathFor(outputDir, "voyd-tuned"),
      typeScriptNode: imagePathFor(outputDir, "typescript"),
      python3: imagePathFor(outputDir, "python"),
      rust: imagePathFor(outputDir, "rust"),
      swift: imagePathFor(outputDir, "swift"),
      go: imagePathFor(outputDir, "go"),
      java: imagePathFor(outputDir, "java"),
    },
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });
  if (cli.keepImages) {
    fs.mkdirSync(path.join(outputDir, "images"), { recursive: true });
  }

  const pythonBin = cli.skip.has("python")
    ? null
    : resolvePythonBin(cli.pythonBin);
  const rustcBin = cli.skip.has("rust") ? null : resolveRustcBin(cli.rustcBin);
  const swiftcBin = cli.skip.has("swift")
    ? null
    : resolveSwiftcBin(cli.swiftcBin);
  const goBin = cli.skip.has("go") ? null : resolveGoBin(cli.goBin);
  const javacBin = cli.skip.has("java") ? null : resolveJavacBin(cli.javacBin);
  const javaBin = cli.skip.has("java") ? null : resolveJavaBin(cli.javaBin);

  const tsCompile = cli.skip.has("typescript")
    ? null
    : (() => {
        process.stderr.write("Compiling TypeScript renderer\n");
        return measure(cli.tscBin, ["-p", "tsconfig.json"]);
      })();

  const rustCompile = cli.skip.has("rust")
    ? null
    : (() => {
        process.stderr.write("Compiling Rust renderer\n");
        return measure(rustcBin, [
          "-O",
          "-o",
          paths.rustBinary,
          sourcePaths.rustRenderer,
        ]);
      })();

  const swiftCompile = cli.skip.has("swift")
    ? null
    : (() => {
        process.stderr.write("Compiling Swift renderer\n");
        return measure(swiftcBin, [
          "-O",
          "-o",
          paths.swiftBinary,
          sourcePaths.swiftRenderer,
        ]);
      })();

  const goCompile = cli.skip.has("go")
    ? null
    : (() => {
        process.stderr.write("Compiling Go renderer\n");
        return measure(goBin, [
          "build",
          "-o",
          paths.goBinary,
          sourcePaths.goRenderer,
        ]);
      })();

  const javaCompile = cli.skip.has("java")
    ? null
    : (() => {
        process.stderr.write("Compiling Java renderer\n");
        fs.rmSync(javaClassesDir, { recursive: true, force: true });
        fs.mkdirSync(javaClassesDir, { recursive: true });
        return measure(javacBin, [
          "-d",
          javaClassesDir,
          sourcePaths.javaRenderer,
        ]);
      })();

  const baselineCompile = cli.skip.has("baseline")
    ? null
    : (() => {
        try {
          process.stderr.write("Emitting baseline Voyd wasm\n");
          const compile = measure(
            cli.vtBin,
            ["--emit-wasm", "--opt", sourcePaths.voydBaselineEntry],
            {
              captureStdout: true,
            },
          );
          fs.writeFileSync(paths.voydBaselineWasm, compile.stdout);
          return compile;
        } catch (error) {
          const message = String(
            error instanceof Error ? error.message : error,
          );
          warnings.push(`Baseline Voyd emit failed: ${message}`);
          process.stderr.write(`${warnings.at(-1)}\n`);
          return null;
        }
      })();

  const tunedCompile = cli.skip.has("tuned")
    ? null
    : (() => {
        try {
          process.stderr.write("Emitting tuned Voyd wasm\n");
          const compile = measure(
            cli.vtBin,
            ["--emit-wasm", "--opt", sourcePaths.voydTunedEntry],
            {
              captureStdout: true,
            },
          );
          fs.writeFileSync(paths.voydTunedWasm, compile.stdout);
          return compile;
        } catch (error) {
          const message = String(
            error instanceof Error ? error.message : error,
          );
          warnings.push(`Tuned Voyd emit failed: ${message}`);
          process.stderr.write(`${warnings.at(-1)}\n`);
          return null;
        }
      })();

  const baselineRun = baselineCompile
    ? (() => {
        try {
          return benchmarkLanguage({
            label: "Voyd baseline run",
            imagePath: paths.images.voydBaselineWasm,
            keepImages: cli.keepImages,
            iterations: cli.iterations,
            warmupRuns: cli.warmupRuns,
            run: (imagePath) =>
              measure(cli.vtBin, ["--run-wasm", paths.voydBaselineWasm], {
                stdoutFilePath: imagePath,
              }).elapsedMs,
          });
        } catch (error) {
          const message = String(
            error instanceof Error ? error.message : error,
          );
          warnings.push(`Baseline Voyd run failed: ${message}`);
          process.stderr.write(`${warnings.at(-1)}\n`);
          return null;
        }
      })()
    : null;

  const tunedRun = tunedCompile
    ? (() => {
        try {
          return benchmarkLanguage({
            label: "Voyd tuned run",
            imagePath: paths.images.voydTunedWasm,
            keepImages: cli.keepImages,
            iterations: cli.iterations,
            warmupRuns: cli.warmupRuns,
            run: (imagePath) =>
              measure(cli.vtBin, ["--run-wasm", paths.voydTunedWasm], {
                stdoutFilePath: imagePath,
              }).elapsedMs,
          });
        } catch (error) {
          const message = String(
            error instanceof Error ? error.message : error,
          );
          warnings.push(`Tuned Voyd run failed: ${message}`);
          process.stderr.write(`${warnings.at(-1)}\n`);
          return null;
        }
      })()
    : null;

  const tsRun = tsCompile
    ? benchmarkLanguage({
        label: "TypeScript run",
        imagePath: paths.images.typeScriptNode,
        keepImages: cli.keepImages,
        iterations: cli.iterations,
        warmupRuns: cli.warmupRuns,
        run: (imagePath) =>
          measure(process.execPath, [
            sourcePaths.tsRenderer,
            "--out",
            imagePath,
          ]).elapsedMs,
      })
    : null;

  const pyRun = pythonBin
    ? benchmarkLanguage({
        label: "Python run",
        imagePath: paths.images.python3,
        keepImages: cli.keepImages,
        iterations: cli.iterations,
        warmupRuns: cli.warmupRuns,
        run: (imagePath) =>
          measure(pythonBin, [sourcePaths.pyRenderer, "--out", imagePath])
            .elapsedMs,
      })
    : null;

  const rustRun = rustCompile
    ? benchmarkLanguage({
        label: "Rust run",
        imagePath: paths.images.rust,
        keepImages: cli.keepImages,
        iterations: cli.iterations,
        warmupRuns: cli.warmupRuns,
        run: (imagePath) =>
          measure(paths.rustBinary, ["--out", imagePath]).elapsedMs,
      })
    : null;

  const swiftRun = swiftCompile
    ? benchmarkLanguage({
        label: "Swift run",
        imagePath: paths.images.swift,
        keepImages: cli.keepImages,
        iterations: cli.iterations,
        warmupRuns: cli.warmupRuns,
        run: (imagePath) =>
          measure(paths.swiftBinary, ["--out", imagePath]).elapsedMs,
      })
    : null;

  const goRun = goCompile
    ? benchmarkLanguage({
        label: "Go run",
        imagePath: paths.images.go,
        keepImages: cli.keepImages,
        iterations: cli.iterations,
        warmupRuns: cli.warmupRuns,
        run: (imagePath) =>
          measure(paths.goBinary, ["--out", imagePath]).elapsedMs,
      })
    : null;

  const javaRun = javaCompile
    ? benchmarkLanguage({
        label: "Java run",
        imagePath: paths.images.java,
        keepImages: cli.keepImages,
        iterations: cli.iterations,
        warmupRuns: cli.warmupRuns,
        run: (imagePath) =>
          measure(javaBin, [
            "-cp",
            javaClassesDir,
            "VTrace",
            "--out",
            imagePath,
          ]).elapsedMs,
      })
    : null;

  const runResults = {
    voydBaselineWasm: baselineRun,
    voydTunedWasm: tunedRun,
    typeScriptNode: tsRun,
    python3: pyRun,
    rust: rustRun,
    swift: swiftRun,
    go: goRun,
    java: javaRun,
  };

  const results = {
    generatedAt: new Date().toISOString(),
    config: {
      iterations: cli.iterations,
      warmupRuns: cli.warmupRuns,
      imageWidth: 200,
      samplesPerPixel: 10,
      maxDepth: 50,
      keepImages: cli.keepImages,
      skipped: Array.from(cli.skip).sort(),
    },
    compile: {
      voydBaselineEmitWasmMs: baselineCompile
        ? baselineCompile.elapsedMs
        : null,
      voydTunedEmitWasmMs: tunedCompile ? tunedCompile.elapsedMs : null,
      typeScriptTscMs: tsCompile ? tsCompile.elapsedMs : null,
      pythonCompileMs: null,
      rustcMs: rustCompile ? rustCompile.elapsedMs : null,
      swiftcMs: swiftCompile ? swiftCompile.elapsedMs : null,
      goBuildMs: goCompile ? goCompile.elapsedMs : null,
      javacMs: javaCompile ? javaCompile.elapsedMs : null,
    },
    run: {
      ...runResults,
      relativeSpeed: buildRelativeSpeed(runResults),
    },
    outputs: {
      voydBaselineWasmPath: baselineCompile ? paths.voydBaselineWasm : null,
      voydBaselineWasmBytes: baselineCompile
        ? safeStatSize(paths.voydBaselineWasm)
        : null,
      voydTunedWasmPath: tunedCompile ? paths.voydTunedWasm : null,
      voydTunedWasmBytes: tunedCompile
        ? safeStatSize(paths.voydTunedWasm)
        : null,
      typeScriptRendererPath: sourcePaths.tsRenderer,
      pythonRendererPath: sourcePaths.pyRenderer,
      rustRendererPath: sourcePaths.rustRenderer,
      rustBinaryPath: rustCompile ? paths.rustBinary : null,
      rustBinaryBytes: rustCompile ? safeStatSize(paths.rustBinary) : null,
      swiftRendererPath: sourcePaths.swiftRenderer,
      swiftBinaryPath: swiftCompile ? paths.swiftBinary : null,
      swiftBinaryBytes: swiftCompile ? safeStatSize(paths.swiftBinary) : null,
      goRendererPath: sourcePaths.goRenderer,
      goBinaryPath: goCompile ? paths.goBinary : null,
      goBinaryBytes: goCompile ? safeStatSize(paths.goBinary) : null,
      javaRendererPath: sourcePaths.javaRenderer,
      javaClassesPath: javaCompile ? javaClassesDir : null,
      images: {
        voydBaselineWasm: cli.keepImages ? paths.images.voydBaselineWasm : null,
        voydTunedWasm: cli.keepImages ? paths.images.voydTunedWasm : null,
        typeScriptNode: cli.keepImages ? paths.images.typeScriptNode : null,
        python3: cli.keepImages ? paths.images.python3 : null,
        rust: cli.keepImages ? paths.images.rust : null,
        swift: cli.keepImages ? paths.images.swift : null,
        go: cli.keepImages ? paths.images.go : null,
        java: cli.keepImages ? paths.images.java : null,
      },
    },
    warnings,
  };

  const resultsPath = path.join(outputDir, "results.json");
  fs.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main();
