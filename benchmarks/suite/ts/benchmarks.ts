type BenchmarkName = "compute" | "log";

type Config = {
  benchmark: BenchmarkName;
  samples: number;
  warmup: number;
  matrixSize: number;
  matrixRounds: number;
  logLines: number;
  logRounds: number;
  topN: number;
};

type CountEntry = {
  key: string;
  value: number;
};

const config: Config = {
  benchmark: readBenchmarkName("BENCH_NAME", "compute"),
  samples: readPositiveInt("BENCH_SAMPLES", 5),
  warmup: readPositiveInt("BENCH_WARMUP", 2),
  matrixSize: readPositiveInt("BENCH_MATRIX_SIZE", 112),
  matrixRounds: readPositiveInt("BENCH_MATRIX_ROUNDS", 12),
  logLines: readPositiveInt("BENCH_LOG_LINES", 12000),
  logRounds: readPositiveInt("BENCH_LOG_ROUNDS", 12),
  topN: readPositiveInt("BENCH_TOP_N", 5),
};

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBenchmarkName(name: string, fallback: BenchmarkName): BenchmarkName {
  const raw = process.env[name];
  return raw === "log" ? "log" : fallback;
}

function buildMatrix(size: number, multiplierA: number, multiplierB: number): Int32Array {
  const values = new Int32Array(size * size);
  for (let row = 0; row < size; row += 1) {
    const rowBase = row * size;
    for (let col = 0; col < size; col += 1) {
      values[rowBase + col] =
        ((row * multiplierA + col * multiplierB + 7) % 17) + 1;
    }
  }
  return values;
}

function runComputeBenchmark(
  left: Int32Array,
  right: Int32Array,
  scratch: Int32Array,
  size: number,
  rounds: number,
): string {
  let checksum = 0;

  for (let round = 0; round < rounds; round += 1) {
    scratch.fill(0);

    for (let row = 0; row < size; row += 1) {
      const rowBase = row * size;
      for (let inner = 0; inner < size; inner += 1) {
        const leftValue = left[rowBase + inner] + round;
        const rightBase = inner * size;
        for (let col = 0; col < size; col += 1) {
          scratch[rowBase + col] += leftValue * right[rightBase + col];
        }
      }
    }

    for (let index = 0; index < scratch.length; index += 37) {
      checksum += scratch[index] * ((index % 13) + 1);
    }
  }

  return String(checksum);
}

function buildLogPayload(lineCount: number): string {
  const regions = ["us-east", "us-west", "eu-central", "ap-south"];
  const methods = ["GET", "POST", "PUT", "DELETE"];
  const lines: string[] = new Array(lineCount);

  for (let index = 0; index < lineCount; index += 1) {
    const tenant = `tenant-${index % 37}`;
    const region = regions[index % regions.length]!;
    const method = methods[index % methods.length]!;
    const path = buildPath(index);
    const codeRoll = (index * 17 + 11) % 20;
    const status =
      codeRoll === 0 ? 503 : codeRoll <= 2 ? 429 : codeRoll <= 4 ? 404 : index % 9 === 0 ? 201 : 200;
    const latency = 15 + ((index * index * 7 + 19) % 900);
    const bytes = 200 + ((index * 31 + 17) % 5000);

    lines[index] =
      `${method}|${path}|tenant=${tenant}&region=${region}&status=${status}&latency=${latency}&bytes=${bytes}|host=api.example.test|ua=bench/${(index % 5) + 1}.0`;
  }

  return lines.join("\n");
}

function buildPath(index: number): string {
  switch (index % 6) {
    case 0:
      return `/api/orders/${index % 307}`;
    case 1:
      return `/api/orders/${index % 307}/items/${(index * 7) % 29}`;
    case 2:
      return `/api/users/${(index * 13) % 251}`;
    case 3:
      return `/api/catalog/${(index * 17) % 97}`;
    case 4:
      return "/health";
    default:
      return `/static/app.${index % 9}.js`;
  }
}

function normalizePath(path: string): string {
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.length > 0 && isDigits(part)) {
      parts[index] = ":id";
    }
  }
  return parts.join("/");
}

function isDigits(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) {
      return false;
    }
  }
  return true;
}

function methodCode(method: string): number {
  switch (method) {
    case "GET":
      return 1;
    case "POST":
      return 2;
    case "PUT":
      return 3;
    default:
      return 4;
  }
}

function regionCode(region: string): number {
  switch (region) {
    case "us-east":
      return 1;
    case "us-west":
      return 2;
    case "eu-central":
      return 3;
    default:
      return 4;
  }
}

function paramValue(part: string): string {
  const separatorIndex = part.indexOf("=");
  return separatorIndex >= 0 ? part.slice(separatorIndex + 1) : "";
}

function runLogBenchmark(payload: string, rounds: number, topN: number): string {
  let checksum = 0;

  for (let round = 0; round < rounds; round += 1) {
    const lines = payload.split("\n");
    for (const line of lines) {
      const fields = line.split("|");
      const method = fields[0]!;
      const normalizedPath = normalizePath(fields[1]!);
      const params = fields[2]!.split("&");
      const region = paramValue(params[1]!);
      const status = Number.parseInt(paramValue(params[2]!), 10);
      const latency = Number.parseInt(paramValue(params[3]!), 10);
      const bytes = Number.parseInt(paramValue(params[4]!), 10);
      checksum +=
        methodCode(method) * 3 +
        normalizedPath.length * 5 +
        regionCode(region) * 7 +
        status +
        latency +
        bytes +
        fields[3]!.length +
        fields[4]!.length +
        topN;
    }
  }

  return String(checksum);
}

function collectSamples(run: () => string, warmup: number, samples: number): { summary: string; sampleMs: number[] } {
  let summary = "";
  for (let index = 0; index < warmup; index += 1) {
    summary = run();
  }

  const sampleMs: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = process.hrtime.bigint();
    summary = run();
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    sampleMs.push(elapsedMs);
  }
  return { summary, sampleMs };
}

function main(): void {
  const result =
    config.benchmark === "compute"
      ? (() => {
          const left = buildMatrix(config.matrixSize, 17, 31);
          const right = buildMatrix(config.matrixSize, 29, 19);
          const scratch = new Int32Array(config.matrixSize * config.matrixSize);
          return collectSamples(
            () =>
              runComputeBenchmark(
                left,
                right,
                scratch,
                config.matrixSize,
                config.matrixRounds,
              ),
            config.warmup,
            config.samples,
          );
        })()
      : (() => {
          const payload = buildLogPayload(config.logLines);
          return collectSamples(
            () => runLogBenchmark(payload, config.logRounds, config.topN),
            config.warmup,
            config.samples,
          );
        })();

  process.stdout.write(`SUMMARY:${result.summary}\n`);
  process.stdout.write(
    `SAMPLES_MS:${result.sampleMs.map((value) => value.toFixed(3)).join(",")}\n`,
  );
}

main();
