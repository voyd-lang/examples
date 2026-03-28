package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type countEntry struct {
	key   string
	value int
}

func readPositiveInt(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func buildMatrix(size int, multiplierA int, multiplierB int) []int {
	values := make([]int, size*size)
	for row := 0; row < size; row += 1 {
		rowBase := row * size
		for col := 0; col < size; col += 1 {
			values[rowBase+col] = ((row*multiplierA + col*multiplierB + 7) % 17) + 1
		}
	}
	return values
}

func runComputeBenchmark(left []int, right []int, scratch []int, size int, rounds int) string {
	checksum := 0
	total := size * size

	for round := 0; round < rounds; round += 1 {
		for index := 0; index < total; index += 1 {
			scratch[index] = 0
		}

		for row := 0; row < size; row += 1 {
			rowBase := row * size
			for inner := 0; inner < size; inner += 1 {
				leftValue := left[rowBase+inner] + round
				rightBase := inner * size
				for col := 0; col < size; col += 1 {
					scratch[rowBase+col] += leftValue * right[rightBase+col]
				}
			}
		}

		for index := 0; index < total; index += 37 {
			checksum += scratch[index] * ((index % 13) + 1)
		}
	}

	return strconv.Itoa(checksum)
}

func buildPath(index int) string {
	switch index % 6 {
	case 0:
		return fmt.Sprintf("/api/orders/%d", index%307)
	case 1:
		return fmt.Sprintf("/api/orders/%d/items/%d", index%307, (index*7)%29)
	case 2:
		return fmt.Sprintf("/api/users/%d", (index*13)%251)
	case 3:
		return fmt.Sprintf("/api/catalog/%d", (index*17)%97)
	case 4:
		return "/health"
	default:
		return fmt.Sprintf("/static/app.%d.js", index%9)
	}
}

func buildLogPayload(lineCount int) string {
	regions := []string{"us-east", "us-west", "eu-central", "ap-south"}
	methods := []string{"GET", "POST", "PUT", "DELETE"}
	lines := make([]string, lineCount)

	for index := 0; index < lineCount; index += 1 {
		codeRoll := (index*17 + 11) % 20
		status := 200
		if codeRoll == 0 {
			status = 503
		} else if codeRoll <= 2 {
			status = 429
		} else if codeRoll <= 4 {
			status = 404
		} else if index%9 == 0 {
			status = 201
		}

		lines[index] = strings.Join([]string{
			methods[index%len(methods)],
			buildPath(index),
			strings.Join([]string{
				fmt.Sprintf("tenant=tenant-%d", index%37),
				fmt.Sprintf("region=%s", regions[index%len(regions)]),
				fmt.Sprintf("status=%d", status),
				fmt.Sprintf("latency=%d", 15+((index*index*7+19)%900)),
				fmt.Sprintf("bytes=%d", 200+((index*31+17)%5000)),
			}, "&"),
			"host=api.example.test",
			fmt.Sprintf("ua=bench/%d.0", (index%5)+1),
		}, "|")
	}

	return strings.Join(lines, "\n")
}

func isDigits(value string) bool {
	if len(value) == 0 {
		return false
	}
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

func normalizePath(path string) string {
	parts := strings.Split(path, "/")
	for index, part := range parts {
		if isDigits(part) {
			parts[index] = ":id"
		}
	}
	return strings.Join(parts, "/")
}

func methodCode(method string) int {
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

func regionCode(region string) int {
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

func paramValue(part string) string {
	pieces := strings.SplitN(part, "=", 2)
	if len(pieces) == 2 {
		return pieces[1]
	}
	return ""
}

func runLogBenchmark(payload string, rounds int, topN int) string {
	checksum := 0

	for round := 0; round < rounds; round += 1 {
		lines := strings.Split(payload, "\n")
		for _, line := range lines {
			fields := strings.Split(line, "|")
			method := fields[0]
			path := normalizePath(fields[1])
			params := strings.Split(fields[2], "&")
			region := paramValue(params[1])
			status, _ := strconv.Atoi(paramValue(params[2]))
			latency, _ := strconv.Atoi(paramValue(params[3]))
			byteCount, _ := strconv.Atoi(paramValue(params[4]))

			checksum += methodCode(method)*3 +
				len(path)*5 +
				regionCode(region)*7 +
				status +
				latency +
				byteCount +
				len(fields[3]) +
				len(fields[4]) +
				topN
		}
	}

	return strconv.Itoa(checksum)
}

func collectSamples(run func() string, warmup int, samples int) (string, []float64) {
	summary := ""
	for index := 0; index < warmup; index += 1 {
		summary = run()
	}

	sampleMs := make([]float64, 0, samples)
	for index := 0; index < samples; index += 1 {
		startedAt := time.Now()
		summary = run()
		sampleMs = append(sampleMs, float64(time.Since(startedAt).Microseconds())/1000.0)
	}
	return summary, sampleMs
}

func main() {
	benchmark := os.Getenv("BENCH_NAME")
	samples := readPositiveInt("BENCH_SAMPLES", 5)
	warmup := readPositiveInt("BENCH_WARMUP", 2)
	matrixSize := readPositiveInt("BENCH_MATRIX_SIZE", 112)
	matrixRounds := readPositiveInt("BENCH_MATRIX_ROUNDS", 12)
	logLines := readPositiveInt("BENCH_LOG_LINES", 12000)
	logRounds := readPositiveInt("BENCH_LOG_ROUNDS", 12)
	topN := readPositiveInt("BENCH_TOP_N", 5)

	var summary string
	var sampleMs []float64

	if benchmark == "log" {
		payload := buildLogPayload(logLines)
		summary, sampleMs = collectSamples(
			func() string {
				return runLogBenchmark(payload, logRounds, topN)
			},
			warmup,
			samples,
		)
	} else {
		left := buildMatrix(matrixSize, 17, 31)
		right := buildMatrix(matrixSize, 29, 19)
		scratch := make([]int, matrixSize*matrixSize)
		summary, sampleMs = collectSamples(
			func() string {
				return runComputeBenchmark(left, right, scratch, matrixSize, matrixRounds)
			},
			warmup,
			samples,
		)
	}

	formattedSamples := make([]string, len(sampleMs))
	for index, value := range sampleMs {
		formattedSamples[index] = fmt.Sprintf("%.3f", value)
	}

	fmt.Printf("SUMMARY:%s\n", summary)
	fmt.Printf("SAMPLES_MS:%s\n", strings.Join(formattedSamples, ","))
}
