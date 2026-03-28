import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

public final class VTrace {
    private VTrace() {}

    private interface RandomSource {
        double next();

        default double nextRange(double min, double max) {
            return min + (max - min) * next();
        }
    }

    private static final class Mulberry32Random implements RandomSource {
        private int state;

        private Mulberry32Random(int seed) {
            this.state = seed;
        }

        @Override
        public double next() {
            state += 0x6D2B79F5;
            int t = (state ^ (state >>> 15)) * (1 | state);
            t ^= t + ((t ^ (t >>> 7)) * (61 | t));
            long unsigned = (t ^ (t >>> 14)) & 0xFFFFFFFFL;
            return (double) unsigned / 4294967296.0;
        }
    }

    private static final class Vec3 {
        private final double x;
        private final double y;
        private final double z;

        private Vec3(double x, double y, double z) {
            this.x = x;
            this.y = y;
            this.z = z;
        }

        private static Vec3 zero() {
            return new Vec3(0.0, 0.0, 0.0);
        }

        private static Vec3 random(RandomSource rng, double min, double max) {
            return new Vec3(
                rng.nextRange(min, max),
                rng.nextRange(min, max),
                rng.nextRange(min, max)
            );
        }

        private static Vec3 randomUnitVector(RandomSource rng) {
            while (true) {
                Vec3 p = random(rng, -1.0, 1.0);
                double lensq = p.lenSquared();
                if (lensq > 1e-160 && lensq <= 1.0) {
                    return p.divScalar(Math.sqrt(lensq));
                }
            }
        }

        private static Vec3 randomInUnitDisk(RandomSource rng) {
            while (true) {
                Vec3 p = new Vec3(rng.nextRange(-1.0, 1.0), rng.nextRange(-1.0, 1.0), 0.0);
                if (p.lenSquared() < 1.0) {
                    return p;
                }
            }
        }

        private Vec3 add(Vec3 other) {
            return new Vec3(x + other.x, y + other.y, z + other.z);
        }

        private Vec3 sub(Vec3 other) {
            return new Vec3(x - other.x, y - other.y, z - other.z);
        }

        private Vec3 neg() {
            return new Vec3(-x, -y, -z);
        }

        private Vec3 mulVec(Vec3 other) {
            return new Vec3(x * other.x, y * other.y, z * other.z);
        }

        private Vec3 mulScalar(double scalar) {
            return new Vec3(x * scalar, y * scalar, z * scalar);
        }

        private Vec3 divScalar(double scalar) {
            return new Vec3(x / scalar, y / scalar, z / scalar);
        }

        private Vec3 cross(Vec3 other) {
            return new Vec3(
                y * other.z - z * other.y,
                z * other.x - x * other.z,
                x * other.y - y * other.x
            );
        }

        private double dot(Vec3 other) {
            return x * other.x + y * other.y + z * other.z;
        }

        private double len() {
            return Math.sqrt(lenSquared());
        }

        private double lenSquared() {
            return x * x + y * y + z * z;
        }

        private boolean nearZero() {
            return Math.abs(x) < 1e-8 && Math.abs(y) < 1e-8 && Math.abs(z) < 1e-8;
        }

        private Vec3 unitVector() {
            return divScalar(len());
        }

        private Vec3 reflect(Vec3 normal) {
            return sub(normal.mulScalar(2.0 * dot(normal)));
        }

        private Vec3 refract(Vec3 normal, double etaiOverEtat) {
            double cosTheta = Math.min(neg().dot(normal), 1.0);
            Vec3 rOutPerp = add(normal.mulScalar(cosTheta)).mulScalar(etaiOverEtat);
            Vec3 rOutParallel = normal.mulScalar(-Math.sqrt(Math.abs(1.0 - rOutPerp.lenSquared())));
            return rOutPerp.add(rOutParallel);
        }
    }

    private static final class Ray {
        private final Vec3 origin;
        private final Vec3 direction;

        private Ray(Vec3 origin, Vec3 direction) {
            this.origin = origin;
            this.direction = direction;
        }

        private Vec3 at(double t) {
            return origin.add(direction.mulScalar(t));
        }
    }

    private static final class Interval {
        private final double min;
        private final double max;

        private Interval(double min, double max) {
            this.min = min;
            this.max = max;
        }

        private double clamp(double x) {
            if (x < min) {
                return min;
            }
            if (x > max) {
                return max;
            }
            return x;
        }

        private boolean surrounds(double x) {
            return min < x && x < max;
        }
    }

    private static final int LAMBERTIAN_KIND = 0;
    private static final int METAL_KIND = 1;
    private static final int DIELECTRIC_KIND = 2;

    private static final class Material {
        private final int kind;
        private final Vec3 albedo;
        private final double fuzz;
        private final double refractionIndex;

        private Material(int kind, Vec3 albedo, double fuzz, double refractionIndex) {
            this.kind = kind;
            this.albedo = albedo;
            this.fuzz = fuzz;
            this.refractionIndex = refractionIndex;
        }
    }

    private static final class ScatterTarget {
        private final Vec3 attenuation;
        private final Ray scattered;

        private ScatterTarget(Vec3 attenuation, Ray scattered) {
            this.attenuation = attenuation;
            this.scattered = scattered;
        }
    }

    private static final class HitRecord {
        private Vec3 p = Vec3.zero();
        private Vec3 normal = Vec3.zero();
        private Material mat = new Material(LAMBERTIAN_KIND, Vec3.zero(), 0.0, 1.0);
        private double t = 0.0;
        private boolean frontFace = false;

        private void setFaceNormal(Ray ray, Vec3 outwardNormal) {
            frontFace = ray.direction.dot(outwardNormal) < 0.0;
            normal = frontFace ? outwardNormal : outwardNormal.mulScalar(-1.0);
        }
    }

    private static ScatterTarget scatter(Material material, Ray rIn, HitRecord rec, RandomSource rng) {
        if (material.kind == LAMBERTIAN_KIND) {
            Vec3 scatterDirection = rec.normal.add(Vec3.randomUnitVector(rng));
            if (scatterDirection.nearZero()) {
                scatterDirection = rec.normal;
            }
            return new ScatterTarget(material.albedo, new Ray(rec.p, scatterDirection));
        }
        if (material.kind == METAL_KIND) {
            Vec3 reflected = rIn.direction.reflect(rec.normal).unitVector()
                .add(Vec3.randomUnitVector(rng).mulScalar(material.fuzz));
            return new ScatterTarget(material.albedo, new Ray(rec.p, reflected));
        }

        double ri = rec.frontFace ? 1.0 / material.refractionIndex : material.refractionIndex;
        Vec3 unitDirection = rIn.direction.unitVector();
        double cosTheta = Math.min(unitDirection.neg().dot(rec.normal), 1.0);
        double sinTheta = Math.sqrt(1.0 - cosTheta * cosTheta);
        Vec3 direction;
        if (ri * sinTheta > 1.0 || reflectance(cosTheta, material.refractionIndex) > rng.next()) {
            direction = unitDirection.reflect(rec.normal);
        } else {
            direction = unitDirection.refract(rec.normal, ri);
        }
        return new ScatterTarget(new Vec3(1.0, 1.0, 1.0), new Ray(rec.p, direction));
    }

    private static final class Sphere {
        private final Vec3 center;
        private final double radius;
        private final Material mat;

        private Sphere(Vec3 center, double radius, Material mat) {
            this.center = center;
            this.radius = radius;
            this.mat = mat;
        }

        private boolean hit(Ray ray, Interval rayT, HitRecord rec) {
            Vec3 oc = center.sub(ray.origin);
            double a = ray.direction.lenSquared();
            double h = ray.direction.dot(oc);
            double c = oc.lenSquared() - radius * radius;
            double discriminant = h * h - a * c;
            if (discriminant < 0.0) {
                return false;
            }

            double sqrtd = Math.sqrt(discriminant);
            double root = (h - sqrtd) / a;
            if (!rayT.surrounds(root)) {
                root = (h + sqrtd) / a;
                if (!rayT.surrounds(root)) {
                    return false;
                }
            }

            rec.t = root;
            rec.p = ray.at(root);
            rec.mat = mat;
            Vec3 outwardNormal = rec.p.sub(center).divScalar(radius);
            rec.setFaceNormal(ray, outwardNormal);
            return true;
        }
    }

    private static final class HittableList {
        private final List<Sphere> objects = new ArrayList<>();

        private void add(Sphere object) {
            objects.add(object);
        }

        private boolean hit(Ray ray, Interval rayT, HitRecord rec) {
            HitRecord tempRec = new HitRecord();
            boolean hitAnything = false;
            double closestSoFar = rayT.max;

            for (Sphere object : objects) {
                if (object.hit(ray, new Interval(rayT.min, closestSoFar), tempRec)) {
                    hitAnything = true;
                    closestSoFar = tempRec.t;
                    rec.p = tempRec.p;
                    rec.normal = tempRec.normal;
                    rec.mat = tempRec.mat;
                    rec.t = tempRec.t;
                    rec.frontFace = tempRec.frontFace;
                }
            }

            return hitAnything;
        }
    }

    private static final class Camera {
        private final int imageWidth;
        private final int imageHeight;
        private final int samplesPerPixel;
        private final int maxDepth;
        private final Vec3 center;
        private final double pixelSamplesScale;
        private final Vec3 pixel00Loc;
        private final Vec3 pixelDeltaU;
        private final Vec3 pixelDeltaV;
        private final double defocusAngle;
        private final Vec3 defocusDiskU;
        private final Vec3 defocusDiskV;

        private Camera(
            double aspectRatio,
            int imageWidth,
            int samplesPerPixel,
            int maxDepth,
            Vec3 lookFrom,
            Vec3 lookAt,
            Vec3 vup,
            double vfov,
            double defocusAngle,
            double focusDist
        ) {
            this.imageWidth = imageWidth;
            this.imageHeight = Math.max(1, (int) (imageWidth / aspectRatio));
            this.samplesPerPixel = samplesPerPixel;
            this.maxDepth = maxDepth;
            this.center = lookFrom;

            double theta = degreesToRadians(vfov);
            double h = Math.tan(theta / 2.0);
            double viewportHeight = 2.0 * h * focusDist;
            double viewportWidth = viewportHeight * ((double) imageWidth / imageHeight);

            Vec3 w = lookFrom.sub(lookAt).unitVector();
            Vec3 u = vup.cross(w);
            Vec3 v = w.cross(u);

            Vec3 viewportU = u.mulScalar(viewportWidth);
            Vec3 viewportV = v.mulScalar(-viewportHeight);

            this.pixelDeltaU = viewportU.divScalar(imageWidth);
            this.pixelDeltaV = viewportV.divScalar(imageHeight);

            Vec3 viewportUpperLeft = center
                .sub(w.mulScalar(focusDist))
                .sub(viewportU.divScalar(2.0))
                .sub(viewportV.divScalar(2.0));

            this.pixel00Loc = viewportUpperLeft.add(pixelDeltaU.add(pixelDeltaV).mulScalar(0.5));
            this.pixelSamplesScale = 1.0 / samplesPerPixel;
            this.defocusAngle = defocusAngle;

            double defocusRadius = focusDist * Math.tan(degreesToRadians(defocusAngle / 2.0));
            this.defocusDiskU = u.mulScalar(defocusRadius);
            this.defocusDiskV = v.mulScalar(defocusRadius);
        }

        private void render(HittableList world, RandomSource rng, Writer output) throws IOException {
            output.write("P3\n" + imageWidth + " " + imageHeight + "\n255\n");

            for (int j = 0; j < imageHeight; j += 1) {
                System.err.print("\rScanlines remaining: " + (imageHeight - j));
                for (int i = 0; i < imageWidth; i += 1) {
                    Vec3 color = new Vec3(1.0, 1.0, 1.0);
                    for (int sample = 0; sample < samplesPerPixel; sample += 1) {
                        Ray ray = getRay(i, j, rng);
                        color = color.add(rayColor(ray, maxDepth, world, rng));
                    }
                    output.write(colorToLine(color.mulScalar(pixelSamplesScale)));
                }
            }

            System.err.println();
            output.flush();
        }

        private Ray getRay(int i, int j, RandomSource rng) {
            Vec3 offset = sampleSquare(rng);
            Vec3 pixelSample = pixel00Loc
                .add(pixelDeltaU.mulScalar(i + offset.x))
                .add(pixelDeltaV.mulScalar(j + offset.y));
            Vec3 rayOrigin = defocusAngle <= 0.0 ? center : defocusDiskSample(rng);
            return new Ray(rayOrigin, pixelSample.sub(rayOrigin));
        }

        private Vec3 defocusDiskSample(RandomSource rng) {
            Vec3 p = Vec3.randomInUnitDisk(rng);
            return center.add(defocusDiskU.mulScalar(p.x)).add(defocusDiskV.mulScalar(p.y));
        }
    }

    private static double degreesToRadians(double degrees) {
        return degrees * Math.PI / 180.0;
    }

    private static Vec3 sampleSquare(RandomSource rng) {
        return new Vec3(rng.next() - 0.5, rng.next() - 0.5, 0.0);
    }

    private static double reflectance(double cosine, double refractionIndex) {
        double r0 = (1.0 - refractionIndex) / (1.0 + refractionIndex);
        r0 *= r0;
        return r0 + (1.0 - r0) * Math.pow(1.0 - cosine, 5.0);
    }

    private static Vec3 rayColor(Ray ray, int depth, HittableList world, RandomSource rng) {
        if (depth <= 0) {
            return Vec3.zero();
        }

        HitRecord rec = new HitRecord();
        if (world.hit(ray, new Interval(0.001, Double.POSITIVE_INFINITY), rec)) {
            ScatterTarget target = scatter(rec.mat, ray, rec, rng);
            return target.attenuation.mulVec(rayColor(target.scattered, depth - 1, world, rng));
        }

        Vec3 unitDirection = ray.direction.unitVector();
        double a = 0.5 * (unitDirection.y + 1.0);
        return new Vec3(1.0, 1.0, 1.0)
            .mulScalar(1.0 - a)
            .add(new Vec3(0.5, 0.7, 1.0).mulScalar(a));
    }

    private static double linearToGamma(double linearComponent) {
        return linearComponent > 0.0 ? Math.sqrt(linearComponent) : 0.0;
    }

    private static int toPixel(double color) {
        return (int) Math.floor(256.0 * new Interval(0.0, 0.999).clamp(linearToGamma(color)));
    }

    private static String colorToLine(Vec3 color) {
        return toPixel(color.x) + " " + toPixel(color.y) + " " + toPixel(color.z) + "\n";
    }

    private static final class RenderOptions {
        private int imageWidth = 300;
        private int samplesPerPixel = 20;
        private int maxDepth = 50;
        private String outPath = null;
        private Integer seed = null;
    }

    private static int defaultSeed() {
        return (int) System.nanoTime();
    }

    private static void renderVTrace(RenderOptions options) throws IOException {
        RandomSource rng = new Mulberry32Random(options.seed == null ? defaultSeed() : options.seed);
        HittableList world = new HittableList();
        world.add(new Sphere(
            new Vec3(0.0, -1000.0, 0.0),
            1000.0,
            new Material(LAMBERTIAN_KIND, new Vec3(0.5, 0.5, 0.5), 0.0, 1.0)
        ));

        for (int a = -11; a < 11; a += 1) {
            for (int b = -11; b < 11; b += 1) {
                double chooseMat = rng.next();
                Vec3 center = new Vec3(a + 0.9 * rng.next(), 0.2, b + 0.9 * rng.next());

                if (center.sub(new Vec3(4.0, 0.2, 0.0)).len() > 0.9) {
                    if (chooseMat < 0.8) {
                        Vec3 albedo = Vec3.random(rng, 0.0, 1.0).mulVec(Vec3.random(rng, 0.0, 1.0));
                        world.add(new Sphere(
                            center,
                            0.2,
                            new Material(LAMBERTIAN_KIND, albedo, 0.0, 1.0)
                        ));
                    } else if (chooseMat < 0.95) {
                        Vec3 albedo = Vec3.random(rng, 0.5, 1.0);
                        double fuzz = rng.nextRange(0.0, 0.5);
                        world.add(new Sphere(
                            center,
                            0.2,
                            new Material(METAL_KIND, albedo, fuzz, 1.0)
                        ));
                    } else {
                        world.add(new Sphere(
                            center,
                            0.2,
                            new Material(DIELECTRIC_KIND, new Vec3(1.0, 1.0, 1.0), 0.0, 1.5)
                        ));
                    }
                }
            }
        }

        world.add(new Sphere(
            new Vec3(0.0, 1.0, 0.0),
            1.0,
            new Material(DIELECTRIC_KIND, new Vec3(1.0, 1.0, 1.0), 0.0, 1.5)
        ));
        world.add(new Sphere(
            new Vec3(-4.0, 1.0, 0.0),
            1.0,
            new Material(LAMBERTIAN_KIND, new Vec3(0.4, 0.3, 0.2), 0.0, 1.0)
        ));
        world.add(new Sphere(
            new Vec3(4.0, 1.0, 0.0),
            1.0,
            new Material(METAL_KIND, new Vec3(0.7, 0.6, 0.5), 0.0, 1.0)
        ));

        Camera camera = new Camera(
            16.0 / 9.0,
            options.imageWidth,
            options.samplesPerPixel,
            options.maxDepth,
            new Vec3(13.0, 2.0, 3.0),
            new Vec3(0.0, 0.0, 0.0),
            new Vec3(0.0, 1.0, 0.0),
            20.0,
            0.6,
            10.0
        );

        if (options.outPath == null) {
            try (BufferedWriter writer =
                new BufferedWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8))) {
                camera.render(world, rng, writer);
            }
            return;
        }

        try (BufferedWriter writer = Files.newBufferedWriter(Path.of(options.outPath), StandardCharsets.UTF_8)) {
            camera.render(world, rng, writer);
        }
    }

    private static RenderOptions parseArgs(String[] args) {
        RenderOptions options = new RenderOptions();
        for (int index = 0; index < args.length; index += 1) {
            String arg = args[index];
            String next = index + 1 < args.length ? args[index + 1] : null;
            if ("--out".equals(arg) && next != null) {
                options.outPath = next;
                index += 1;
            } else if ("--seed".equals(arg) && next != null) {
                try {
                    options.seed = Integer.parseUnsignedInt(next);
                } catch (NumberFormatException ignored) {
                    // Ignore invalid values to match the existing CLI behavior.
                }
                index += 1;
            } else if ("--image-width".equals(arg) && next != null) {
                try {
                    options.imageWidth = Integer.parseInt(next);
                } catch (NumberFormatException ignored) {
                    // Ignore invalid values to match the existing CLI behavior.
                }
                index += 1;
            } else if ("--samples-per-pixel".equals(arg) && next != null) {
                try {
                    options.samplesPerPixel = Integer.parseInt(next);
                } catch (NumberFormatException ignored) {
                    // Ignore invalid values to match the existing CLI behavior.
                }
                index += 1;
            } else if ("--max-depth".equals(arg) && next != null) {
                try {
                    options.maxDepth = Integer.parseInt(next);
                } catch (NumberFormatException ignored) {
                    // Ignore invalid values to match the existing CLI behavior.
                }
                index += 1;
            }
        }
        return options;
    }

    public static void main(String[] args) {
        try {
            renderVTrace(parseArgs(args));
        } catch (Exception error) {
            System.err.println(error);
            System.exit(1);
        }
    }
}
