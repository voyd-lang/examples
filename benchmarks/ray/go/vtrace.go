package main

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"time"
)

type RandomSource interface {
	Next() float64
	NextRange(min float64, max float64) float64
}

type Mulberry32Random struct {
	state uint32
}

func NewMulberry32Random(seed uint32) *Mulberry32Random {
	return &Mulberry32Random{state: seed}
}

func (rng *Mulberry32Random) Next() float64 {
	rng.state += 0x6D2B79F5
	t := (rng.state ^ (rng.state >> 15)) * (1 | rng.state)
	t ^= t + ((t ^ (t >> 7)) * (61 | t))
	return float64(t^(t>>14)) / 4294967296.0
}

func (rng *Mulberry32Random) NextRange(min float64, max float64) float64 {
	return min + (max-min)*rng.Next()
}

type Vec3 struct {
	x float64
	y float64
	z float64
}

func NewVec3(x float64, y float64, z float64) Vec3 {
	return Vec3{x: x, y: y, z: z}
}

func ZeroVec3() Vec3 {
	return NewVec3(0.0, 0.0, 0.0)
}

func RandomVec3(rng RandomSource, min float64, max float64) Vec3 {
	return NewVec3(
		rng.NextRange(min, max),
		rng.NextRange(min, max),
		rng.NextRange(min, max),
	)
}

func RandomUnitVector(rng RandomSource) Vec3 {
	for {
		p := RandomVec3(rng, -1.0, 1.0)
		lensq := p.LenSquared()
		if lensq > 1e-160 && lensq <= 1.0 {
			return p.DivScalar(math.Sqrt(lensq))
		}
	}
}

func RandomInUnitDisk(rng RandomSource) Vec3 {
	for {
		p := NewVec3(rng.NextRange(-1.0, 1.0), rng.NextRange(-1.0, 1.0), 0.0)
		if p.LenSquared() < 1.0 {
			return p
		}
	}
}

func (v Vec3) Add(other Vec3) Vec3 {
	return NewVec3(v.x+other.x, v.y+other.y, v.z+other.z)
}

func (v Vec3) Sub(other Vec3) Vec3 {
	return NewVec3(v.x-other.x, v.y-other.y, v.z-other.z)
}

func (v Vec3) Neg() Vec3 {
	return NewVec3(-v.x, -v.y, -v.z)
}

func (v Vec3) MulVec(other Vec3) Vec3 {
	return NewVec3(v.x*other.x, v.y*other.y, v.z*other.z)
}

func (v Vec3) MulScalar(scalar float64) Vec3 {
	return NewVec3(v.x*scalar, v.y*scalar, v.z*scalar)
}

func (v Vec3) DivScalar(scalar float64) Vec3 {
	return NewVec3(v.x/scalar, v.y/scalar, v.z/scalar)
}

func (v Vec3) Cross(other Vec3) Vec3 {
	return NewVec3(
		v.y*other.z-v.z*other.y,
		v.z*other.x-v.x*other.z,
		v.x*other.y-v.y*other.x,
	)
}

func (v Vec3) Dot(other Vec3) float64 {
	return v.x*other.x + v.y*other.y + v.z*other.z
}

func (v Vec3) Len() float64 {
	return math.Sqrt(v.LenSquared())
}

func (v Vec3) LenSquared() float64 {
	return v.x*v.x + v.y*v.y + v.z*v.z
}

func (v Vec3) NearZero() bool {
	return math.Abs(v.x) < 1e-8 && math.Abs(v.y) < 1e-8 && math.Abs(v.z) < 1e-8
}

func (v Vec3) UnitVector() Vec3 {
	return v.DivScalar(v.Len())
}

func (v Vec3) Reflect(normal Vec3) Vec3 {
	return v.Sub(normal.MulScalar(2.0 * v.Dot(normal)))
}

func (v Vec3) Refract(normal Vec3, etaiOverEtat float64) Vec3 {
	cosTheta := math.Min(v.Neg().Dot(normal), 1.0)
	rOutPerp := v.Add(normal.MulScalar(cosTheta)).MulScalar(etaiOverEtat)
	rOutParallel := normal.MulScalar(-math.Sqrt(math.Abs(1.0 - rOutPerp.LenSquared())))
	return rOutPerp.Add(rOutParallel)
}

type Ray struct {
	origin    Vec3
	direction Vec3
}

func NewRay(origin Vec3, direction Vec3) Ray {
	return Ray{origin: origin, direction: direction}
}

func (ray Ray) At(t float64) Vec3 {
	return ray.origin.Add(ray.direction.MulScalar(t))
}

type Interval struct {
	min float64
	max float64
}

func NewInterval(min float64, max float64) Interval {
	return Interval{min: min, max: max}
}

func (interval Interval) Clamp(x float64) float64 {
	if x < interval.min {
		return interval.min
	}
	if x > interval.max {
		return interval.max
	}
	return x
}

func (interval Interval) Surrounds(x float64) bool {
	return interval.min < x && x < interval.max
}

const (
	lambertianKind = iota
	metalKind
	dielectricKind
)

type Material struct {
	kind            int
	albedo          Vec3
	fuzz            float64
	refractionIndex float64
}

type ScatterTarget struct {
	attenuation Vec3
	scattered   Ray
}

type HitRecord struct {
	p         Vec3
	normal    Vec3
	mat       Material
	t         float64
	frontFace bool
}

func NewHitRecord() HitRecord {
	return HitRecord{
		p:      ZeroVec3(),
		normal: ZeroVec3(),
		mat: Material{
			kind:   lambertianKind,
			albedo: ZeroVec3(),
		},
		t:         0.0,
		frontFace: false,
	}
}

func (rec *HitRecord) SetFaceNormal(ray Ray, outwardNormal Vec3) {
	rec.frontFace = ray.direction.Dot(outwardNormal) < 0.0
	if rec.frontFace {
		rec.normal = outwardNormal
	} else {
		rec.normal = outwardNormal.MulScalar(-1.0)
	}
}

func Scatter(material Material, rIn Ray, rec HitRecord, rng RandomSource) (ScatterTarget, bool) {
	switch material.kind {
	case lambertianKind:
		scatterDirection := rec.normal.Add(RandomUnitVector(rng))
		if scatterDirection.NearZero() {
			scatterDirection = rec.normal
		}
		return ScatterTarget{
			attenuation: material.albedo,
			scattered:   NewRay(rec.p, scatterDirection),
		}, true
	case metalKind:
		reflected := rIn.direction.Reflect(rec.normal).UnitVector().Add(
			RandomUnitVector(rng).MulScalar(material.fuzz),
		)
		return ScatterTarget{
			attenuation: material.albedo,
			scattered:   NewRay(rec.p, reflected),
		}, true
	case dielectricKind:
		ri := material.refractionIndex
		if rec.frontFace {
			ri = 1.0 / material.refractionIndex
		}
		unitDirection := rIn.direction.UnitVector()
		cosTheta := math.Min(unitDirection.Neg().Dot(rec.normal), 1.0)
		sinTheta := math.Sqrt(1.0 - cosTheta*cosTheta)
		var direction Vec3
		if ri*sinTheta > 1.0 || Reflectance(cosTheta, material.refractionIndex) > rng.Next() {
			direction = unitDirection.Reflect(rec.normal)
		} else {
			direction = unitDirection.Refract(rec.normal, ri)
		}
		return ScatterTarget{
			attenuation: NewVec3(1.0, 1.0, 1.0),
			scattered:   NewRay(rec.p, direction),
		}, true
	default:
		return ScatterTarget{}, false
	}
}

type Sphere struct {
	center Vec3
	radius float64
	mat    Material
}

func (sphere Sphere) Hit(ray Ray, rayT Interval, rec *HitRecord) bool {
	oc := sphere.center.Sub(ray.origin)
	a := ray.direction.LenSquared()
	h := ray.direction.Dot(oc)
	c := oc.LenSquared() - sphere.radius*sphere.radius
	discriminant := h*h - a*c
	if discriminant < 0.0 {
		return false
	}

	sqrtd := math.Sqrt(discriminant)
	root := (h - sqrtd) / a
	if !rayT.Surrounds(root) {
		root = (h + sqrtd) / a
		if !rayT.Surrounds(root) {
			return false
		}
	}

	rec.t = root
	rec.p = ray.At(root)
	rec.mat = sphere.mat
	outwardNormal := rec.p.Sub(sphere.center).DivScalar(sphere.radius)
	rec.SetFaceNormal(ray, outwardNormal)
	return true
}

type HittableList struct {
	objects []Sphere
}

func NewHittableList() *HittableList {
	return &HittableList{objects: make([]Sphere, 0)}
}

func (list *HittableList) Add(object Sphere) {
	list.objects = append(list.objects, object)
}

func (list *HittableList) Hit(ray Ray, rayT Interval, rec *HitRecord) bool {
	tempRec := NewHitRecord()
	hitAnything := false
	closestSoFar := rayT.max

	for _, object := range list.objects {
		if object.Hit(ray, NewInterval(rayT.min, closestSoFar), &tempRec) {
			hitAnything = true
			closestSoFar = tempRec.t
			*rec = tempRec
		}
	}

	return hitAnything
}

type Camera struct {
	imageWidth        int
	imageHeight       int
	samplesPerPixel   int
	maxDepth          int
	center            Vec3
	pixelSamplesScale float64
	pixel00Loc        Vec3
	pixelDeltaU       Vec3
	pixelDeltaV       Vec3
	defocusAngle      float64
	defocusDiskU      Vec3
	defocusDiskV      Vec3
}

func NewCamera(
	aspectRatio float64,
	imageWidth int,
	samplesPerPixel int,
	maxDepth int,
	lookFrom Vec3,
	lookAt Vec3,
	vup Vec3,
	vfov float64,
	defocusAngle float64,
	focusDist float64,
) Camera {
	imageHeight := maxInt(1, int(float64(imageWidth)/aspectRatio))
	center := lookFrom

	theta := DegreesToRadians(vfov)
	h := math.Tan(theta / 2.0)
	viewportHeight := 2.0 * h * focusDist
	viewportWidth := viewportHeight * (float64(imageWidth) / float64(imageHeight))

	w := lookFrom.Sub(lookAt).UnitVector()
	u := vup.Cross(w)
	v := w.Cross(u)

	viewportU := u.MulScalar(viewportWidth)
	viewportV := v.MulScalar(-viewportHeight)

	pixelDeltaU := viewportU.DivScalar(float64(imageWidth))
	pixelDeltaV := viewportV.DivScalar(float64(imageHeight))

	viewportUpperLeft := center.
		Sub(w.MulScalar(focusDist)).
		Sub(viewportU.DivScalar(2.0)).
		Sub(viewportV.DivScalar(2.0))

	pixel00Loc := viewportUpperLeft.Add(pixelDeltaU.Add(pixelDeltaV).MulScalar(0.5))
	pixelSamplesScale := 1.0 / float64(samplesPerPixel)
	defocusRadius := focusDist * math.Tan(DegreesToRadians(defocusAngle/2.0))

	return Camera{
		imageWidth:        imageWidth,
		imageHeight:       imageHeight,
		samplesPerPixel:   samplesPerPixel,
		maxDepth:          maxDepth,
		center:            center,
		pixelSamplesScale: pixelSamplesScale,
		pixel00Loc:        pixel00Loc,
		pixelDeltaU:       pixelDeltaU,
		pixelDeltaV:       pixelDeltaV,
		defocusAngle:      defocusAngle,
		defocusDiskU:      u.MulScalar(defocusRadius),
		defocusDiskV:      v.MulScalar(defocusRadius),
	}
}

func (camera Camera) Render(world *HittableList, rng RandomSource, output io.Writer) error {
	writer := bufio.NewWriter(output)
	if _, err := fmt.Fprintf(writer, "P3\n%d %d\n255\n", camera.imageWidth, camera.imageHeight); err != nil {
		return err
	}

	for j := 0; j < camera.imageHeight; j++ {
		fmt.Fprintf(os.Stderr, "\rScanlines remaining: %d", camera.imageHeight-j)
		for i := 0; i < camera.imageWidth; i++ {
			color := NewVec3(1.0, 1.0, 1.0)
			for sample := 0; sample < camera.samplesPerPixel; sample++ {
				ray := camera.GetRay(i, j, rng)
				color = color.Add(RayColor(ray, camera.maxDepth, world, rng))
			}
			if _, err := writer.WriteString(ColorToLine(color.MulScalar(camera.pixelSamplesScale))); err != nil {
				return err
			}
		}
	}

	fmt.Fprintln(os.Stderr)
	return writer.Flush()
}

func (camera Camera) GetRay(i int, j int, rng RandomSource) Ray {
	offset := SampleSquare(rng)
	pixelSample := camera.pixel00Loc.
		Add(camera.pixelDeltaU.MulScalar(float64(i) + offset.x)).
		Add(camera.pixelDeltaV.MulScalar(float64(j) + offset.y))
	rayOrigin := camera.center
	if camera.defocusAngle > 0.0 {
		rayOrigin = camera.DefocusDiskSample(rng)
	}
	return NewRay(rayOrigin, pixelSample.Sub(rayOrigin))
}

func (camera Camera) DefocusDiskSample(rng RandomSource) Vec3 {
	p := RandomInUnitDisk(rng)
	return camera.center.
		Add(camera.defocusDiskU.MulScalar(p.x)).
		Add(camera.defocusDiskV.MulScalar(p.y))
}

func DegreesToRadians(degrees float64) float64 {
	return degrees * math.Pi / 180.0
}

func SampleSquare(rng RandomSource) Vec3 {
	return NewVec3(rng.Next()-0.5, rng.Next()-0.5, 0.0)
}

func Reflectance(cosine float64, refractionIndex float64) float64 {
	r0 := (1.0 - refractionIndex) / (1.0 + refractionIndex)
	r0 *= r0
	return r0 + (1.0-r0)*math.Pow(1.0-cosine, 5.0)
}

func RayColor(ray Ray, depth int, world *HittableList, rng RandomSource) Vec3 {
	if depth <= 0 {
		return ZeroVec3()
	}

	rec := NewHitRecord()
	if world.Hit(ray, NewInterval(0.001, math.Inf(1)), &rec) {
		if target, ok := Scatter(rec.mat, ray, rec, rng); ok {
			return target.attenuation.MulVec(RayColor(target.scattered, depth-1, world, rng))
		}
		return ZeroVec3()
	}

	unitDirection := ray.direction.UnitVector()
	a := 0.5 * (unitDirection.y + 1.0)
	return NewVec3(1.0, 1.0, 1.0).MulScalar(1.0 - a).Add(NewVec3(0.5, 0.7, 1.0).MulScalar(a))
}

func LinearToGamma(linearComponent float64) float64 {
	if linearComponent > 0.0 {
		return math.Sqrt(linearComponent)
	}
	return 0.0
}

func ToPixel(color float64) int {
	return int(math.Trunc(256.0 * NewInterval(0.0, 0.999).Clamp(LinearToGamma(color))))
}

func ColorToLine(color Vec3) string {
	return fmt.Sprintf("%d %d %d\n", ToPixel(color.x), ToPixel(color.y), ToPixel(color.z))
}

type RenderOptions struct {
	imageWidth      int
	samplesPerPixel int
	maxDepth        int
	outPath         string
	seed            *uint32
}

func DefaultSeed() uint32 {
	return uint32(time.Now().UnixNano()) + 1
}

func RenderVTrace(options RenderOptions) error {
	seed := DefaultSeed()
	if options.seed != nil {
		seed = *options.seed
	}
	rng := NewMulberry32Random(seed)
	world := NewHittableList()
	world.Add(Sphere{
		center: NewVec3(0.0, -1000.0, 0.0),
		radius: 1000.0,
		mat: Material{
			kind:   lambertianKind,
			albedo: NewVec3(0.5, 0.5, 0.5),
		},
	})

	for a := -11; a < 11; a++ {
		for b := -11; b < 11; b++ {
			chooseMat := rng.Next()
			center := NewVec3(float64(a)+0.9*rng.Next(), 0.2, float64(b)+0.9*rng.Next())

			if center.Sub(NewVec3(4.0, 0.2, 0.0)).Len() > 0.9 {
				if chooseMat < 0.8 {
					albedo := RandomVec3(rng, 0.0, 1.0).MulVec(RandomVec3(rng, 0.0, 1.0))
					world.Add(Sphere{
						center: center,
						radius: 0.2,
						mat: Material{
							kind:   lambertianKind,
							albedo: albedo,
						},
					})
				} else if chooseMat < 0.95 {
					albedo := RandomVec3(rng, 0.5, 1.0)
					fuzz := rng.NextRange(0.0, 0.5)
					world.Add(Sphere{
						center: center,
						radius: 0.2,
						mat: Material{
							kind:   metalKind,
							albedo: albedo,
							fuzz:   fuzz,
						},
					})
				} else {
					world.Add(Sphere{
						center: center,
						radius: 0.2,
						mat: Material{
							kind:            dielectricKind,
							refractionIndex: 1.5,
						},
					})
				}
			}
		}
	}

	world.Add(Sphere{
		center: NewVec3(0.0, 1.0, 0.0),
		radius: 1.0,
		mat: Material{
			kind:            dielectricKind,
			refractionIndex: 1.5,
		},
	})
	world.Add(Sphere{
		center: NewVec3(-4.0, 1.0, 0.0),
		radius: 1.0,
		mat: Material{
			kind:   lambertianKind,
			albedo: NewVec3(0.4, 0.3, 0.2),
		},
	})
	world.Add(Sphere{
		center: NewVec3(4.0, 1.0, 0.0),
		radius: 1.0,
		mat: Material{
			kind:   metalKind,
			albedo: NewVec3(0.7, 0.6, 0.5),
			fuzz:   0.0,
		},
	})

	camera := NewCamera(
		16.0/9.0,
		options.imageWidth,
		options.samplesPerPixel,
		options.maxDepth,
		NewVec3(13.0, 2.0, 3.0),
		NewVec3(0.0, 0.0, 0.0),
		NewVec3(0.0, 1.0, 0.0),
		20.0,
		0.6,
		10.0,
	)

	if options.outPath == "" {
		return camera.Render(world, rng, os.Stdout)
	}

	file, err := os.Create(options.outPath)
	if err != nil {
		return err
	}
	defer file.Close()
	return camera.Render(world, rng, file)
}

func ParseArgs(args []string) RenderOptions {
	options := RenderOptions{
		imageWidth:      300,
		samplesPerPixel: 20,
		maxDepth:        50,
		outPath:         "",
		seed:            nil,
	}

	for index := 0; index < len(args); index++ {
		arg := args[index]
		if index+1 >= len(args) {
			break
		}
		next := args[index+1]
		switch arg {
		case "--out":
			options.outPath = next
			index++
		case "--seed":
			if parsed, err := strconv.ParseUint(next, 10, 32); err == nil {
				seed := uint32(parsed)
				options.seed = &seed
			}
			index++
		case "--image-width":
			if parsed, err := strconv.Atoi(next); err == nil {
				options.imageWidth = parsed
			}
			index++
		case "--samples-per-pixel":
			if parsed, err := strconv.Atoi(next); err == nil {
				options.samplesPerPixel = parsed
			}
			index++
		case "--max-depth":
			if parsed, err := strconv.Atoi(next); err == nil {
				options.maxDepth = parsed
			}
			index++
		}
	}

	return options
}

func maxInt(lhs int, rhs int) int {
	if lhs > rhs {
		return lhs
	}
	return rhs
}

func main() {
	options := ParseArgs(os.Args[1:])
	if err := RenderVTrace(options); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
