use std::collections::HashMap;
use std::env;
use std::time::Instant;

fn read_positive_int(name: &str, fallback: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn build_matrix(size: usize, multiplier_a: i32, multiplier_b: i32) -> Vec<i32> {
    let mut values = vec![0; size * size];
    for row in 0..size {
        let row_base = row * size;
        for col in 0..size {
            values[row_base + col] =
                (((row as i32) * multiplier_a + (col as i32) * multiplier_b + 7) % 17) + 1;
        }
    }
    values
}

fn run_compute_benchmark(
    left: &[i32],
    right: &[i32],
    scratch: &mut [i32],
    size: usize,
    rounds: usize,
) -> String {
    let mut checksum = 0_i32;

    for round in 0..rounds {
        scratch.fill(0);

        for row in 0..size {
            let row_base = row * size;
            for inner in 0..size {
                let left_value = left[row_base + inner] + round as i32;
                let right_base = inner * size;
                for col in 0..size {
                    scratch[row_base + col] += left_value * right[right_base + col];
                }
            }
        }

        let mut index = 0;
        while index < scratch.len() {
            checksum += scratch[index] * ((index % 13) as i32 + 1);
            index += 37;
        }
    }

    checksum.to_string()
}

fn build_path(index: usize) -> String {
    match index % 6 {
        0 => format!("/api/orders/{}", index % 307),
        1 => format!("/api/orders/{}/items/{}", index % 307, (index * 7) % 29),
        2 => format!("/api/users/{}", (index * 13) % 251),
        3 => format!("/api/catalog/{}", (index * 17) % 97),
        4 => "/health".to_string(),
        _ => format!("/static/app.{}.js", index % 9),
    }
}

fn build_log_payload(line_count: usize) -> String {
    let regions = ["us-east", "us-west", "eu-central", "ap-south"];
    let methods = ["GET", "POST", "PUT", "DELETE"];
    let mut lines = Vec::with_capacity(line_count);

    for index in 0..line_count {
        let code_roll = (index * 17 + 11) % 20;
        let status = if code_roll == 0 {
            503
        } else if code_roll <= 2 {
            429
        } else if code_roll <= 4 {
            404
        } else if index % 9 == 0 {
            201
        } else {
            200
        };

        lines.push(format!(
            "{}|{}|tenant=tenant-{}&region={}&status={}&latency={}&bytes={}|host=api.example.test|ua=bench/{}.0",
            methods[index % methods.len()],
            build_path(index),
            index % 37,
            regions[index % regions.len()],
            status,
            15 + ((index * index * 7 + 19) % 900),
            200 + ((index * 31 + 17) % 5000),
            (index % 5) + 1
        ));
    }

    lines.join("\n")
}

fn is_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn normalize_path(path: &str) -> String {
    path.split('/')
        .map(|part| if is_digits(part) { ":id" } else { part })
        .collect::<Vec<_>>()
        .join("/")
}

fn method_code(method: &str) -> i32 {
    match method {
        "GET" => 1,
        "POST" => 2,
        "PUT" => 3,
        _ => 4,
    }
}

fn region_code(region: &str) -> i32 {
    match region {
        "us-east" => 1,
        "us-west" => 2,
        "eu-central" => 3,
        _ => 4,
    }
}

fn param_value(part: &str) -> &str {
    part.split_once('=').map(|(_, value)| value).unwrap_or("")
}

fn run_log_benchmark(payload: &str, rounds: usize, top_n: usize) -> String {
    let mut checksum = 0_i32;

    for _ in 0..rounds {
        for line in payload.split('\n') {
            let fields = line.split('|').collect::<Vec<_>>();
            let method = fields[0];
            let path = normalize_path(fields[1]);
            let params = fields[2].split('&').collect::<Vec<_>>();
            let region = param_value(params[1]);
            let status = param_value(params[2]).parse::<i32>().unwrap();
            let latency = param_value(params[3]).parse::<i32>().unwrap();
            let byte_count = param_value(params[4]).parse::<i32>().unwrap();

            checksum += method_code(method) * 3
                + path.len() as i32 * 5
                + region_code(region) * 7
                + status
                + latency
                + byte_count
                + fields[3].len() as i32
                + fields[4].len() as i32
                + top_n as i32;
        }
    }

    checksum.to_string()
}

fn collect_samples<F>(mut run: F, warmup: usize, samples: usize) -> (String, Vec<f64>)
where
    F: FnMut() -> String,
{
    let mut summary = String::new();
    for _ in 0..warmup {
        summary = run();
    }

    let mut sample_ms = Vec::with_capacity(samples);
    for _ in 0..samples {
        let started_at = Instant::now();
        summary = run();
        sample_ms.push(started_at.elapsed().as_secs_f64() * 1000.0);
    }
    (summary, sample_ms)
}

fn main() {
    let benchmark = env::var("BENCH_NAME").unwrap_or_else(|_| "compute".to_string());
    let samples = read_positive_int("BENCH_SAMPLES", 5);
    let warmup = read_positive_int("BENCH_WARMUP", 2);
    let matrix_size = read_positive_int("BENCH_MATRIX_SIZE", 112);
    let matrix_rounds = read_positive_int("BENCH_MATRIX_ROUNDS", 12);
    let log_lines = read_positive_int("BENCH_LOG_LINES", 12000);
    let log_rounds = read_positive_int("BENCH_LOG_ROUNDS", 12);
    let top_n = read_positive_int("BENCH_TOP_N", 5);

    let (summary, sample_ms) = if benchmark == "log" {
        let payload = build_log_payload(log_lines);
        collect_samples(|| run_log_benchmark(&payload, log_rounds, top_n), warmup, samples)
    } else {
        let left = build_matrix(matrix_size, 17, 31);
        let right = build_matrix(matrix_size, 29, 19);
        let mut scratch = vec![0; matrix_size * matrix_size];
        collect_samples(
            || run_compute_benchmark(&left, &right, &mut scratch, matrix_size, matrix_rounds),
            warmup,
            samples,
        )
    };

    println!("SUMMARY:{}", summary);
    println!(
        "SAMPLES_MS:{}",
        sample_ms
            .iter()
            .map(|value| format!("{:.3}", value))
            .collect::<Vec<_>>()
            .join(",")
    );
}
