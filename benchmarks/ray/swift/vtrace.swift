import Foundation

protocol RandomSource: AnyObject {
    func next() -> Double
    func nextRange(_ minimum: Double, _ maximum: Double) -> Double
}

extension RandomSource {
    func nextRange(_ minimum: Double, _ maximum: Double) -> Double {
        minimum + (maximum - minimum) * next()
    }
}

final class SystemRandomSource: RandomSource {
    func next() -> Double {
        Double.random(in: 0.0..<1.0)
    }
}

final class Mulberry32Random: RandomSource {
    private var state: UInt32

    init(seed: UInt32) {
        self.state = seed
    }

    func next() -> Double {
        state = state &+ 0x6D2B79F5
        var t = (state ^ (state >> 15)) &* (1 | state)
        t ^= t &+ ((t ^ (t >> 7)) &* (61 | t))
        return Double(t ^ (t >> 14)) / 4294967296.0
    }
}

struct Vec3 {
    var x: Double
    var y: Double
    var z: Double

    static func zero() -> Vec3 {
        Vec3(x: 0.0, y: 0.0, z: 0.0)
    }

    static func random(_ rng: RandomSource, min: Double = 0.0, max: Double = 1.0) -> Vec3 {
        Vec3(
            x: rng.nextRange(min, max),
            y: rng.nextRange(min, max),
            z: rng.nextRange(min, max)
        )
    }

    static func randomUnitVector(_ rng: RandomSource) -> Vec3 {
        while true {
            let p = Vec3.random(rng, min: -1.0, max: 1.0)
            let lensq = p.lenSquared()
            if lensq > 1e-160 && lensq <= 1.0 {
                return p.divScalar(sqrt(lensq))
            }
        }
    }

    static func randomInUnitDisk(_ rng: RandomSource) -> Vec3 {
        while true {
            let p = Vec3(
                x: rng.nextRange(-1.0, 1.0),
                y: rng.nextRange(-1.0, 1.0),
                z: 0.0
            )
            if p.lenSquared() < 1.0 {
                return p
            }
        }
    }

    func add(_ other: Vec3) -> Vec3 {
        Vec3(x: x + other.x, y: y + other.y, z: z + other.z)
    }

    func sub(_ other: Vec3) -> Vec3 {
        Vec3(x: x - other.x, y: y - other.y, z: z - other.z)
    }

    func neg() -> Vec3 {
        Vec3(x: -x, y: -y, z: -z)
    }

    func mulVec(_ other: Vec3) -> Vec3 {
        Vec3(x: x * other.x, y: y * other.y, z: z * other.z)
    }

    func mulScalar(_ scalar: Double) -> Vec3 {
        Vec3(x: x * scalar, y: y * scalar, z: z * scalar)
    }

    func divScalar(_ scalar: Double) -> Vec3 {
        Vec3(x: x / scalar, y: y / scalar, z: z / scalar)
    }

    func cross(_ other: Vec3) -> Vec3 {
        Vec3(
            x: y * other.z - z * other.y,
            y: z * other.x - x * other.z,
            z: x * other.y - y * other.x
        )
    }

    func dot(_ other: Vec3) -> Double {
        x * other.x + y * other.y + z * other.z
    }

    func len() -> Double {
        sqrt(lenSquared())
    }

    func lenSquared() -> Double {
        x * x + y * y + z * z
    }

    func nearZero() -> Bool {
        abs(x) < 1e-8 && abs(y) < 1e-8 && abs(z) < 1e-8
    }

    func unitVector() -> Vec3 {
        divScalar(len())
    }

    func reflect(_ normal: Vec3) -> Vec3 {
        sub(normal.mulScalar(2.0 * dot(normal)))
    }

    func refract(_ normal: Vec3, _ etaiOverEtat: Double) -> Vec3 {
        let cosTheta = min(neg().dot(normal), 1.0)
        let rOutPerp = add(normal.mulScalar(cosTheta)).mulScalar(etaiOverEtat)
        let rOutParallel = normal.mulScalar(-sqrt(abs(1.0 - rOutPerp.lenSquared())))
        return rOutPerp.add(rOutParallel)
    }
}

typealias Point3 = Vec3
typealias Color = Vec3

struct Ray {
    var origin: Vec3
    var direction: Vec3

    func at(_ t: Double) -> Vec3 {
        origin.add(direction.mulScalar(t))
    }
}

struct Interval {
    var minimum: Double
    var maximum: Double

    func clamp(_ x: Double) -> Double {
        if x < minimum {
            return minimum
        }
        if x > maximum {
            return maximum
        }
        return x
    }

    func surrounds(_ x: Double) -> Bool {
        minimum < x && x < maximum
    }
}

enum Material {
    case lambertian(Color)
    case metal(Color, Double)
    case dielectric(Double)
}

struct ScatterTarget {
    let attenuation: Vec3
    let scattered: Ray
}

struct HitRecord {
    var p = Vec3.zero()
    var normal = Vec3.zero()
    var mat = Material.lambertian(Vec3.zero())
    var t = 0.0
    var frontFace = false

    mutating func setFaceNormal(_ ray: Ray, _ outwardNormal: Vec3) {
        frontFace = ray.direction.dot(outwardNormal) < 0.0
        normal = frontFace ? outwardNormal : outwardNormal.mulScalar(-1.0)
    }
}

func scatter(_ material: Material, _ rIn: Ray, _ rec: HitRecord, _ rng: RandomSource) -> ScatterTarget? {
    switch material {
    case .lambertian(let albedo):
        var scatterDirection = rec.normal.add(Vec3.randomUnitVector(rng))
        if scatterDirection.nearZero() {
            scatterDirection = rec.normal
        }
        return ScatterTarget(attenuation: albedo, scattered: Ray(origin: rec.p, direction: scatterDirection))
    case .metal(let albedo, let fuzz):
        let reflected = rIn.direction.reflect(rec.normal).unitVector().add(
            Vec3.randomUnitVector(rng).mulScalar(fuzz)
        )
        return ScatterTarget(attenuation: albedo, scattered: Ray(origin: rec.p, direction: reflected))
    case .dielectric(let refractionIndex):
        let ri = rec.frontFace ? 1.0 / refractionIndex : refractionIndex
        let unitDirection = rIn.direction.unitVector()
        let cosTheta = min(unitDirection.neg().dot(rec.normal), 1.0)
        let sinTheta = sqrt(1.0 - cosTheta * cosTheta)
        let cannotRefract = ri * sinTheta > 1.0
        let direction: Vec3
        if cannotRefract || reflectance(cosTheta, refractionIndex) > rng.next() {
            direction = unitDirection.reflect(rec.normal)
        } else {
            direction = unitDirection.refract(rec.normal, ri)
        }
        return ScatterTarget(
            attenuation: Vec3(x: 1.0, y: 1.0, z: 1.0),
            scattered: Ray(origin: rec.p, direction: direction)
        )
    }
}

struct Sphere {
    var center: Point3
    var radius: Double
    var mat: Material

    func hit(_ ray: Ray, _ rayT: Interval, _ rec: inout HitRecord) -> Bool {
        let oc = center.sub(ray.origin)
        let a = ray.direction.lenSquared()
        let h = ray.direction.dot(oc)
        let c = oc.lenSquared() - radius * radius
        let discriminant = h * h - a * c
        if discriminant < 0.0 {
            return false
        }

        let sqrtd = sqrt(discriminant)
        var root = (h - sqrtd) / a
        if !rayT.surrounds(root) {
            root = (h + sqrtd) / a
            if !rayT.surrounds(root) {
                return false
            }
        }

        rec.t = root
        rec.p = ray.at(rec.t)
        rec.mat = mat
        let outwardNormal = rec.p.sub(center).divScalar(radius)
        rec.setFaceNormal(ray, outwardNormal)
        return true
    }
}

struct HittableList {
    var objects: [Sphere] = []

    mutating func add(_ object: Sphere) {
        objects.append(object)
    }

    func hit(_ ray: Ray, _ rayT: Interval, _ rec: inout HitRecord) -> Bool {
        var tempRec = HitRecord()
        var hitAnything = false
        var closestSoFar = rayT.maximum

        for object in objects {
            if object.hit(ray, Interval(minimum: rayT.minimum, maximum: closestSoFar), &tempRec) {
                hitAnything = true
                closestSoFar = tempRec.t
                rec = tempRec
            }
        }

        return hitAnything
    }
}

struct Camera {
    let imageWidth: Int
    let imageHeight: Int
    let samplesPerPixel: Int
    let maxDepth: Int
    let center: Point3
    let pixelSamplesScale: Double
    let pixel00Loc: Point3
    let pixelDeltaU: Vec3
    let pixelDeltaV: Vec3
    let defocusAngle: Double
    let defocusDiskU: Vec3
    let defocusDiskV: Vec3

    init(
        aspectRatio: Double,
        imageWidth: Int,
        samplesPerPixel: Int,
        maxDepth: Int,
        lookFrom: Point3,
        lookAt: Point3,
        vup: Vec3,
        vfov: Double,
        defocusAngle: Double,
        focusDist: Double
    ) {
        self.imageWidth = imageWidth
        self.imageHeight = max(1, Int(Double(imageWidth) / aspectRatio))
        self.samplesPerPixel = samplesPerPixel
        self.maxDepth = maxDepth
        self.center = lookFrom

        let theta = degreesToRadians(vfov)
        let h = tan(theta / 2.0)
        let viewportHeight = 2.0 * h * focusDist
        let viewportWidth = viewportHeight * (Double(imageWidth) / Double(self.imageHeight))

        let w = lookFrom.sub(lookAt).unitVector()
        let u = vup.cross(w)
        let v = w.cross(u)

        let viewportU = u.mulScalar(viewportWidth)
        let viewportV = v.mulScalar(-viewportHeight)

        self.pixelDeltaU = viewportU.divScalar(Double(imageWidth))
        self.pixelDeltaV = viewportV.divScalar(Double(self.imageHeight))

        let viewportUpperLeft = center
            .sub(w.mulScalar(focusDist))
            .sub(viewportU.divScalar(2.0))
            .sub(viewportV.divScalar(2.0))

        self.pixel00Loc = viewportUpperLeft.add(pixelDeltaU.add(pixelDeltaV).mulScalar(0.5))
        self.pixelSamplesScale = 1.0 / Double(samplesPerPixel)
        self.defocusAngle = defocusAngle

        let defocusRadius = focusDist * tan(degreesToRadians(defocusAngle / 2.0))
        self.defocusDiskU = u.mulScalar(defocusRadius)
        self.defocusDiskV = v.mulScalar(defocusRadius)
    }

    func render(world: HittableList, rng: RandomSource, sink: TextSink) throws {
        try sink.write("P3\n\(imageWidth) \(imageHeight)\n255\n")

        for j in 0..<imageHeight {
            fputs("\rScanlines remaining: \(imageHeight - j)", stderr)
            var scanline = ""
            for i in 0..<imageWidth {
                var color = Vec3(x: 1.0, y: 1.0, z: 1.0)
                for _ in 0..<samplesPerPixel {
                    let ray = getRay(i: i, j: j, rng: rng)
                    color = color.add(rayColor(ray: ray, depth: maxDepth, world: world, rng: rng))
                }
                scanline += colorToLine(color.mulScalar(pixelSamplesScale))
            }
            try sink.write(scanline)
        }

        fputs("\n", stderr)
    }

    private func getRay(i: Int, j: Int, rng: RandomSource) -> Ray {
        let offset = sampleSquare(rng)
        let pixelSample = pixel00Loc
            .add(pixelDeltaU.mulScalar(Double(i) + offset.x))
            .add(pixelDeltaV.mulScalar(Double(j) + offset.y))
        let rayOrigin = defocusAngle <= 0.0 ? center : defocusDiskSample(rng)
        let rayDirection = pixelSample.sub(rayOrigin)
        return Ray(origin: rayOrigin, direction: rayDirection)
    }

    private func defocusDiskSample(_ rng: RandomSource) -> Point3 {
        let p = Vec3.randomInUnitDisk(rng)
        return center
            .add(defocusDiskU.mulScalar(p.x))
            .add(defocusDiskV.mulScalar(p.y))
    }
}

final class TextSink {
    private let handle: FileHandle

    init(handle: FileHandle) {
        self.handle = handle
    }

    func write(_ text: String) throws {
        if let data = text.data(using: .utf8) {
            try handle.write(contentsOf: data)
        }
    }
}

func degreesToRadians(_ degrees: Double) -> Double {
    degrees * Double.pi / 180.0
}

func sampleSquare(_ rng: RandomSource) -> Vec3 {
    Vec3(x: rng.next() - 0.5, y: rng.next() - 0.5, z: 0.0)
}

func reflectance(_ cosine: Double, _ refractionIndex: Double) -> Double {
    var r0 = (1.0 - refractionIndex) / (1.0 + refractionIndex)
    r0 *= r0
    return r0 + (1.0 - r0) * pow(1.0 - cosine, 5.0)
}

func rayColor(ray: Ray, depth: Int, world: HittableList, rng: RandomSource) -> Color {
    if depth <= 0 {
        return Vec3.zero()
    }

    var rec = HitRecord()
    if world.hit(ray, Interval(minimum: 0.001, maximum: .infinity), &rec) {
        if let target = scatter(rec.mat, ray, rec, rng) {
            return target.attenuation.mulVec(
                rayColor(ray: target.scattered, depth: depth - 1, world: world, rng: rng)
            )
        }
        return Vec3.zero()
    }

    let unitDirection = ray.direction.unitVector()
    let a = 0.5 * (unitDirection.y + 1.0)
    return Vec3(x: 1.0, y: 1.0, z: 1.0)
        .mulScalar(1.0 - a)
        .add(Vec3(x: 0.5, y: 0.7, z: 1.0).mulScalar(a))
}

func linearToGamma(_ linearComponent: Double) -> Double {
    linearComponent > 0.0 ? sqrt(linearComponent) : 0.0
}

func toPixel(_ color: Double) -> Int {
    Int((256.0 * Interval(minimum: 0.0, maximum: 0.999).clamp(linearToGamma(color))).rounded(.towardZero))
}

func colorToLine(_ color: Color) -> String {
    "\(toPixel(color.x)) \(toPixel(color.y)) \(toPixel(color.z))\n"
}

struct RenderOptions {
    var imageWidth = 300
    var samplesPerPixel = 20
    var maxDepth = 50
    var outPath: String?
    var seed: UInt32?
}

func defaultSeed() -> UInt32 {
    UInt32(Date().timeIntervalSince1970 * 1_000_000) &+ 1
}

func parseArgs(_ args: [String]) -> RenderOptions {
    var options = RenderOptions()
    var index = 0

    while index < args.count {
        let arg = args[index]
        let next = index + 1 < args.count ? args[index + 1] : nil
        switch (arg, next) {
        case ("--out", let value?):
            options.outPath = value
            index += 2
        case ("--seed", let value?):
            options.seed = UInt32(value)
            index += 2
        case ("--image-width", let value?):
            if let parsed = Int(value) {
                options.imageWidth = parsed
            }
            index += 2
        case ("--samples-per-pixel", let value?):
            if let parsed = Int(value) {
                options.samplesPerPixel = parsed
            }
            index += 2
        case ("--max-depth", let value?):
            if let parsed = Int(value) {
                options.maxDepth = parsed
            }
            index += 2
        default:
            index += 1
        }
    }

    return options
}

func renderVTrace(_ options: RenderOptions) throws {
    let rng: RandomSource = options.seed.map(Mulberry32Random.init(seed:)) ?? SystemRandomSource()
    var world = HittableList()
    world.add(
        Sphere(
            center: Vec3(x: 0.0, y: -1000.0, z: 0.0),
            radius: 1000.0,
            mat: .lambertian(Vec3(x: 0.5, y: 0.5, z: 0.5))
        )
    )

    for a in -11..<11 {
        for b in -11..<11 {
            let chooseMat = rng.next()
            let center = Vec3(
                x: Double(a) + 0.9 * rng.next(),
                y: 0.2,
                z: Double(b) + 0.9 * rng.next()
            )

            if center.sub(Vec3(x: 4.0, y: 0.2, z: 0.0)).len() > 0.9 {
                if chooseMat < 0.8 {
                    let albedo = Vec3.random(rng).mulVec(Vec3.random(rng))
                    world.add(Sphere(center: center, radius: 0.2, mat: .lambertian(albedo)))
                } else if chooseMat < 0.95 {
                    let albedo = Vec3.random(rng, min: 0.5, max: 1.0)
                    let fuzz = rng.nextRange(0.0, 0.5)
                    world.add(Sphere(center: center, radius: 0.2, mat: .metal(albedo, fuzz)))
                } else {
                    world.add(Sphere(center: center, radius: 0.2, mat: .dielectric(1.5)))
                }
            }
        }
    }

    world.add(Sphere(center: Vec3(x: 0.0, y: 1.0, z: 0.0), radius: 1.0, mat: .dielectric(1.5)))
    world.add(
        Sphere(
            center: Vec3(x: -4.0, y: 1.0, z: 0.0),
            radius: 1.0,
            mat: .lambertian(Vec3(x: 0.4, y: 0.3, z: 0.2))
        )
    )
    world.add(
        Sphere(
            center: Vec3(x: 4.0, y: 1.0, z: 0.0),
            radius: 1.0,
            mat: .metal(Vec3(x: 0.7, y: 0.6, z: 0.5), 0.0)
        )
    )

    let camera = Camera(
        aspectRatio: 16.0 / 9.0,
        imageWidth: options.imageWidth,
        samplesPerPixel: options.samplesPerPixel,
        maxDepth: options.maxDepth,
        lookFrom: Vec3(x: 13.0, y: 2.0, z: 3.0),
        lookAt: Vec3(x: 0.0, y: 0.0, z: 0.0),
        vup: Vec3(x: 0.0, y: 1.0, z: 0.0),
        vfov: 20.0,
        defocusAngle: 0.6,
        focusDist: 10.0
    )

    if let outPath = options.outPath {
        FileManager.default.createFile(atPath: outPath, contents: nil)
        let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: outPath))
        defer { try? handle.close() }
        try camera.render(world: world, rng: rng, sink: TextSink(handle: handle))
    } else {
        try camera.render(world: world, rng: rng, sink: TextSink(handle: FileHandle.standardOutput))
    }
}

do {
    try renderVTrace(parseArgs(Array(CommandLine.arguments.dropFirst())))
} catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
