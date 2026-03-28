import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class Benchmarks {
  private Benchmarks() {}

  private record CountEntry(String key, int value) {}

  private static int readPositiveInt(String name, int fallback) {
    String raw = System.getenv(name);
    if (raw == null) {
      return fallback;
    }
    try {
      int parsed = Integer.parseInt(raw);
      return parsed > 0 ? parsed : fallback;
    } catch (NumberFormatException error) {
      return fallback;
    }
  }

  private static int[] buildMatrix(int size, int multiplierA, int multiplierB) {
    int[] values = new int[size * size];
    for (int row = 0; row < size; row += 1) {
      int rowBase = row * size;
      for (int col = 0; col < size; col += 1) {
        values[rowBase + col] = ((row * multiplierA + col * multiplierB + 7) % 17) + 1;
      }
    }
    return values;
  }

  private static String runComputeBenchmark(
      int[] left,
      int[] right,
      int[] scratch,
      int size,
      int rounds
  ) {
    int checksum = 0;
    int total = size * size;

    for (int round = 0; round < rounds; round += 1) {
      Arrays.fill(scratch, 0);

      for (int row = 0; row < size; row += 1) {
        int rowBase = row * size;
        for (int inner = 0; inner < size; inner += 1) {
          int leftValue = left[rowBase + inner] + round;
          int rightBase = inner * size;
          for (int col = 0; col < size; col += 1) {
            scratch[rowBase + col] += leftValue * right[rightBase + col];
          }
        }
      }

      for (int index = 0; index < total; index += 37) {
        checksum += scratch[index] * ((index % 13) + 1);
      }
    }

    return Integer.toString(checksum);
  }

  private static String buildPath(int index) {
    return switch (index % 6) {
      case 0 -> "/api/orders/" + (index % 307);
      case 1 -> "/api/orders/" + (index % 307) + "/items/" + ((index * 7) % 29);
      case 2 -> "/api/users/" + ((index * 13) % 251);
      case 3 -> "/api/catalog/" + ((index * 17) % 97);
      case 4 -> "/health";
      default -> "/static/app." + (index % 9) + ".js";
    };
  }

  private static String buildLogPayload(int lineCount) {
    String[] regions = {"us-east", "us-west", "eu-central", "ap-south"};
    String[] methods = {"GET", "POST", "PUT", "DELETE"};
    StringBuilder out = new StringBuilder(lineCount * 72);

    for (int index = 0; index < lineCount; index += 1) {
      int codeRoll = (index * 17 + 11) % 20;
      int status =
          codeRoll == 0 ? 503 : codeRoll <= 2 ? 429 : codeRoll <= 4 ? 404 : index % 9 == 0 ? 201 : 200;
      if (index > 0) {
        out.append('\n');
      }
      out.append(methods[index % methods.length])
          .append('|').append(buildPath(index))
          .append('|').append("tenant=tenant-").append(index % 37)
          .append("&region=").append(regions[index % regions.length])
          .append("&status=").append(status)
          .append("&latency=").append(15 + ((index * index * 7 + 19) % 900))
          .append("&bytes=").append(200 + ((index * 31 + 17) % 5000))
          .append('|').append("host=api.example.test")
          .append('|').append("ua=bench/").append((index % 5) + 1).append(".0");
    }

    return out.toString();
  }

  private static boolean isDigits(String value) {
    if (value.isEmpty()) {
      return false;
    }
    for (int index = 0; index < value.length(); index += 1) {
      char ch = value.charAt(index);
      if (ch < '0' || ch > '9') {
        return false;
      }
    }
    return true;
  }

  private static String normalizePath(String path) {
    String[] parts = path.split("/", -1);
    for (int index = 0; index < parts.length; index += 1) {
      if (isDigits(parts[index])) {
        parts[index] = ":id";
      }
    }
    return String.join("/", parts);
  }

  private static int methodCode(String method) {
    return switch (method) {
      case "GET" -> 1;
      case "POST" -> 2;
      case "PUT" -> 3;
      default -> 4;
    };
  }

  private static int regionCode(String region) {
    return switch (region) {
      case "us-east" -> 1;
      case "us-west" -> 2;
      case "eu-central" -> 3;
      default -> 4;
    };
  }

  private static String paramValue(String part) {
    int separatorIndex = part.indexOf('=');
    return separatorIndex >= 0 ? part.substring(separatorIndex + 1) : "";
  }

  private static String runLogBenchmark(String payload, int rounds, int topN) {
    int checksum = 0;

    for (int round = 0; round < rounds; round += 1) {
      for (String line : payload.split("\n")) {
        String[] fields = line.split("\\|", -1);
        String method = fields[0];
        String path = normalizePath(fields[1]);
        String[] params = fields[2].split("&", -1);
        String region = paramValue(params[1]);
        int status = Integer.parseInt(paramValue(params[2]));
        int latency = Integer.parseInt(paramValue(params[3]));
        int byteCount = Integer.parseInt(paramValue(params[4]));

        checksum +=
            methodCode(method) * 3
                + path.length() * 5
                + regionCode(region) * 7
                + status
                + latency
                + byteCount
                + fields[3].length()
                + fields[4].length()
                + topN;
      }
    }

    return Integer.toString(checksum);
  }

  private interface SampleRunner {
    String run();
  }

  private record SampleResult(String summary, double[] sampleMs) {}

  private static SampleResult collectSamples(SampleRunner runner, int warmup, int samples) {
    String summary = "";
    for (int index = 0; index < warmup; index += 1) {
      summary = runner.run();
    }

    double[] sampleMs = new double[samples];
    for (int index = 0; index < samples; index += 1) {
      long startedAt = System.nanoTime();
      summary = runner.run();
      sampleMs[index] = (System.nanoTime() - startedAt) / 1_000_000.0;
    }
    return new SampleResult(summary, sampleMs);
  }

  public static void main(String[] args) {
    String benchmark = System.getenv().getOrDefault("BENCH_NAME", "compute");
    int samples = readPositiveInt("BENCH_SAMPLES", 5);
    int warmup = readPositiveInt("BENCH_WARMUP", 2);
    int matrixSize = readPositiveInt("BENCH_MATRIX_SIZE", 112);
    int matrixRounds = readPositiveInt("BENCH_MATRIX_ROUNDS", 12);
    int logLines = readPositiveInt("BENCH_LOG_LINES", 12000);
    int logRounds = readPositiveInt("BENCH_LOG_ROUNDS", 12);
    int topN = readPositiveInt("BENCH_TOP_N", 5);

    SampleResult result;
    if ("log".equals(benchmark)) {
      String payload = buildLogPayload(logLines);
      result = collectSamples(() -> runLogBenchmark(payload, logRounds, topN), warmup, samples);
    } else {
      int[] left = buildMatrix(matrixSize, 17, 31);
      int[] right = buildMatrix(matrixSize, 29, 19);
      int[] scratch = new int[matrixSize * matrixSize];
      result = collectSamples(
          () -> runComputeBenchmark(left, right, scratch, matrixSize, matrixRounds),
          warmup,
          samples
      );
    }

    StringBuilder samplesLine = new StringBuilder();
    for (int index = 0; index < result.sampleMs().length; index += 1) {
      if (index > 0) {
        samplesLine.append(',');
      }
      samplesLine.append(String.format("%.3f", result.sampleMs()[index]));
    }

    System.out.println("SUMMARY:" + result.summary());
    System.out.println("SAMPLES_MS:" + samplesLine);
  }
}
