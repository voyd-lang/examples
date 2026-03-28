import Foundation

struct CountEntry {
    let key: String
    let value: Int
}

func readPositiveInt(_ name: String, fallback: Int) -> Int {
    guard let raw = ProcessInfo.processInfo.environment[name], let parsed = Int(raw), parsed > 0 else {
        return fallback
    }
    return parsed
}

func buildMatrix(size: Int, multiplierA: Int, multiplierB: Int) -> [Int] {
    var values = Array(repeating: 0, count: size * size)
    for row in 0..<size {
        let rowBase = row * size
        for col in 0..<size {
            values[rowBase + col] = ((row * multiplierA + col * multiplierB + 7) % 17) + 1
        }
    }
    return values
}

func runComputeBenchmark(
    left: [Int],
    right: [Int],
    scratch: inout [Int],
    size: Int,
    rounds: Int
) -> String {
    var checksum = 0
    let total = size * size

    for round in 0..<rounds {
        for index in 0..<total {
            scratch[index] = 0
        }

        for row in 0..<size {
            let rowBase = row * size
            for inner in 0..<size {
                let leftValue = left[rowBase + inner] + round
                let rightBase = inner * size
                for col in 0..<size {
                    scratch[rowBase + col] += leftValue * right[rightBase + col]
                }
            }
        }

        var index = 0
        while index < total {
            checksum += scratch[index] * ((index % 13) + 1)
            index += 37
        }
    }

    return String(checksum)
}

func buildPath(_ index: Int) -> String {
    switch index % 6 {
    case 0:
        return "/api/orders/\(index % 307)"
    case 1:
        return "/api/orders/\(index % 307)/items/\((index * 7) % 29)"
    case 2:
        return "/api/users/\((index * 13) % 251)"
    case 3:
        return "/api/catalog/\((index * 17) % 97)"
    case 4:
        return "/health"
    default:
        return "/static/app.\(index % 9).js"
    }
}

func buildLogPayload(lineCount: Int) -> String {
    let regions = ["us-east", "us-west", "eu-central", "ap-south"]
    let methods = ["GET", "POST", "PUT", "DELETE"]
    var lines: [String] = []
    lines.reserveCapacity(lineCount)

    for index in 0..<lineCount {
        let codeRoll = (index * 17 + 11) % 20
        let status: Int
        if codeRoll == 0 {
            status = 503
        } else if codeRoll <= 2 {
            status = 429
        } else if codeRoll <= 4 {
            status = 404
        } else if index % 9 == 0 {
            status = 201
        } else {
            status = 200
        }

        lines.append([
            methods[index % methods.count],
            buildPath(index),
            [
                "tenant=tenant-\(index % 37)",
                "region=\(regions[index % regions.count])",
                "status=\(status)",
                "latency=\(15 + ((index * index * 7 + 19) % 900))",
                "bytes=\(200 + ((index * 31 + 17) % 5000))",
            ].joined(separator: "&"),
            "host=api.example.test",
            "ua=bench/\((index % 5) + 1).0",
        ].joined(separator: "|"))
    }

    return lines.joined(separator: "\n")
}

func isDigits(_ value: String) -> Bool {
    if value.isEmpty {
        return false
    }
    return value.unicodeScalars.allSatisfy { scalar in
        scalar.value >= 48 && scalar.value <= 57
    }
}

func normalizePath(_ path: String) -> String {
    return path
        .split(separator: "/", omittingEmptySubsequences: false)
        .map { part in
            let value = String(part)
            return isDigits(value) ? ":id" : value
        }
        .joined(separator: "/")
}

func methodCode(_ method: String) -> Int {
    switch method {
    case "GET":
        return 1
    case "POST":
        return 2
    case "PUT":
        return 3
    default:
        return 4
    }
}

func regionCode(_ region: String) -> Int {
    switch region {
    case "us-east":
        return 1
    case "us-west":
        return 2
    case "eu-central":
        return 3
    default:
        return 4
    }
}

func paramValue(_ part: String) -> String {
    let pieces = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
    return pieces.count == 2 ? String(pieces[1]) : ""
}

func runLogBenchmark(payload: String, rounds: Int, topN: Int) -> String {
    var checksum = 0

    for _ in 0..<rounds {
        for line in payload.split(separator: "\n", omittingEmptySubsequences: false) {
            let fields = line.split(separator: "|", omittingEmptySubsequences: false)
            let method = String(fields[0])
            let path = normalizePath(String(fields[1]))
            let params = fields[2].split(separator: "&", omittingEmptySubsequences: false)
            let region = paramValue(String(params[1]))
            let status = Int(paramValue(String(params[2])))!
            let latency = Int(paramValue(String(params[3])))!
            let byteCount = Int(paramValue(String(params[4])))!

            checksum +=
                methodCode(method) * 3 +
                path.count * 5 +
                regionCode(region) * 7 +
                status +
                latency +
                byteCount +
                String(fields[3]).count +
                String(fields[4]).count +
                topN
        }
    }

    return String(checksum)
}

func collectSamples(
    run: () -> String,
    warmup: Int,
    samples: Int
) -> (summary: String, sampleMs: [Double]) {
    var summary = ""
    for _ in 0..<warmup {
        summary = run()
    }

    var sampleMs: [Double] = []
    sampleMs.reserveCapacity(samples)
    for _ in 0..<samples {
        let startedAt = DispatchTime.now().uptimeNanoseconds
        summary = run()
        let elapsedNs = DispatchTime.now().uptimeNanoseconds - startedAt
        sampleMs.append(Double(elapsedNs) / 1_000_000.0)
    }
    return (summary, sampleMs)
}

let benchmark = ProcessInfo.processInfo.environment["BENCH_NAME"] == "log" ? "log" : "compute"
let samples = readPositiveInt("BENCH_SAMPLES", fallback: 5)
let warmup = readPositiveInt("BENCH_WARMUP", fallback: 2)
let matrixSize = readPositiveInt("BENCH_MATRIX_SIZE", fallback: 112)
let matrixRounds = readPositiveInt("BENCH_MATRIX_ROUNDS", fallback: 12)
let logLines = readPositiveInt("BENCH_LOG_LINES", fallback: 12000)
let logRounds = readPositiveInt("BENCH_LOG_ROUNDS", fallback: 12)
let topN = readPositiveInt("BENCH_TOP_N", fallback: 5)

let result: (summary: String, sampleMs: [Double])
if benchmark == "log" {
    let payload = buildLogPayload(lineCount: logLines)
    result = collectSamples(
        run: { runLogBenchmark(payload: payload, rounds: logRounds, topN: topN) },
        warmup: warmup,
        samples: samples
    )
} else {
    let left = buildMatrix(size: matrixSize, multiplierA: 17, multiplierB: 31)
    let right = buildMatrix(size: matrixSize, multiplierA: 29, multiplierB: 19)
    var scratch = Array(repeating: 0, count: matrixSize * matrixSize)
    result = collectSamples(
        run: { runComputeBenchmark(left: left, right: right, scratch: &scratch, size: matrixSize, rounds: matrixRounds) },
        warmup: warmup,
        samples: samples
    )
}

print("SUMMARY:\(result.summary)")
print("SAMPLES_MS:\(result.sampleMs.map { String(format: "%.3f", $0) }.joined(separator: ","))")
