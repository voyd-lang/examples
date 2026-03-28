import os
import time


def read_positive_int(name: str, fallback: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return fallback
    try:
        parsed = int(raw)
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def build_matrix(size: int, multiplier_a: int, multiplier_b: int) -> list[int]:
    values = [0] * (size * size)
    for row in range(size):
        row_base = row * size
        for col in range(size):
            values[row_base + col] = ((row * multiplier_a + col * multiplier_b + 7) % 17) + 1
    return values


def run_compute_benchmark(
    left: list[int],
    right: list[int],
    scratch: list[int],
    size: int,
    rounds: int,
) -> str:
    checksum = 0
    total = size * size

    for round_index in range(rounds):
        for index in range(total):
            scratch[index] = 0

        for row in range(size):
            row_base = row * size
            for inner in range(size):
                left_value = left[row_base + inner] + round_index
                right_base = inner * size
                for col in range(size):
                    scratch[row_base + col] += left_value * right[right_base + col]

        for index in range(0, total, 37):
            checksum += scratch[index] * ((index % 13) + 1)

    return str(checksum)


def build_path(index: int) -> str:
    case = index % 6
    if case == 0:
        return f"/api/orders/{index % 307}"
    if case == 1:
        return f"/api/orders/{index % 307}/items/{(index * 7) % 29}"
    if case == 2:
        return f"/api/users/{(index * 13) % 251}"
    if case == 3:
        return f"/api/catalog/{(index * 17) % 97}"
    if case == 4:
        return "/health"
    return f"/static/app.{index % 9}.js"


def build_log_payload(line_count: int) -> str:
    regions = ["us-east", "us-west", "eu-central", "ap-south"]
    methods = ["GET", "POST", "PUT", "DELETE"]
    lines: list[str] = []

    for index in range(line_count):
        code_roll = (index * 17 + 11) % 20
        if code_roll == 0:
            status = 503
        elif code_roll <= 2:
            status = 429
        elif code_roll <= 4:
            status = 404
        elif index % 9 == 0:
            status = 201
        else:
            status = 200

        line = "|".join(
            [
                methods[index % len(methods)],
                build_path(index),
                "&".join(
                    [
                        f"tenant=tenant-{index % 37}",
                        f"region={regions[index % len(regions)]}",
                        f"status={status}",
                        f"latency={15 + ((index * index * 7 + 19) % 900)}",
                        f"bytes={200 + ((index * 31 + 17) % 5000)}",
                    ]
                ),
                "host=api.example.test",
                f"ua=bench/{(index % 5) + 1}.0",
            ]
        )
        lines.append(line)

    return "\n".join(lines)


def is_digits(value: str) -> bool:
    return len(value) > 0 and value.isdigit()


def normalize_path(path: str) -> str:
    parts = path.split("/")
    for index, part in enumerate(parts):
        if is_digits(part):
            parts[index] = ":id"
    return "/".join(parts)


def method_code(method: str) -> int:
    if method == "GET":
        return 1
    if method == "POST":
        return 2
    if method == "PUT":
        return 3
    return 4

def region_code(region: str) -> int:
    if region == "us-east":
        return 1
    if region == "us-west":
        return 2
    if region == "eu-central":
        return 3
    return 4


def param_value(part: str) -> str:
    _, _, value = part.partition("=")
    return value


def run_log_benchmark(payload: str, rounds: int, top_n: int) -> str:
    checksum = 0

    for _ in range(rounds):
        for line in payload.split("\n"):
            fields = line.split("|")
            method = fields[0]
            normalized_path = normalize_path(fields[1])
            params = fields[2].split("&")
            region = param_value(params[1])
            status = int(param_value(params[2]))
            latency = int(param_value(params[3]))
            byte_count = int(param_value(params[4]))

            checksum += (
                method_code(method) * 3
                + len(normalized_path) * 5
                + region_code(region) * 7
                + status
                + latency
                + byte_count
                + len(fields[3])
                + len(fields[4])
                + top_n
            )

    return str(checksum)


def collect_samples(run, warmup: int, samples: int) -> tuple[str, list[float]]:
    summary = ""
    for _ in range(warmup):
        summary = run()

    sample_ms: list[float] = []
    for _ in range(samples):
        started_at = time.perf_counter_ns()
        summary = run()
        sample_ms.append((time.perf_counter_ns() - started_at) / 1_000_000)
    return summary, sample_ms


def main() -> None:
    benchmark = "log" if os.environ.get("BENCH_NAME") == "log" else "compute"
    samples = read_positive_int("BENCH_SAMPLES", 5)
    warmup = read_positive_int("BENCH_WARMUP", 2)
    matrix_size = read_positive_int("BENCH_MATRIX_SIZE", 112)
    matrix_rounds = read_positive_int("BENCH_MATRIX_ROUNDS", 12)
    log_lines = read_positive_int("BENCH_LOG_LINES", 12000)
    log_rounds = read_positive_int("BENCH_LOG_ROUNDS", 12)
    top_n = read_positive_int("BENCH_TOP_N", 5)

    if benchmark == "compute":
        left = build_matrix(matrix_size, 17, 31)
        right = build_matrix(matrix_size, 29, 19)
        scratch = [0] * (matrix_size * matrix_size)
        summary, sample_ms = collect_samples(
            lambda: run_compute_benchmark(left, right, scratch, matrix_size, matrix_rounds),
            warmup,
            samples,
        )
    else:
        payload = build_log_payload(log_lines)
        summary, sample_ms = collect_samples(
            lambda: run_log_benchmark(payload, log_rounds, top_n),
            warmup,
            samples,
        )

    print(f"SUMMARY:{summary}")
    print("SAMPLES_MS:" + ",".join(f"{value:.3f}" for value in sample_ms))


if __name__ == "__main__":
    main()
