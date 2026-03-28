from __future__ import annotations

import argparse
import math
import random
import sys
from typing import Optional, Protocol, TextIO


class RandomSource(Protocol):
    def next(self) -> float: ...
    def next_range(self, minimum: float, maximum: float) -> float: ...


class MathRandom:
    def next(self) -> float:
        return random.random()

    def next_range(self, minimum: float, maximum: float) -> float:
        return minimum + (maximum - minimum) * self.next()


class Mulberry32Random:
    __slots__ = ("state",)

    def __init__(self, seed: int) -> None:
        self.state = seed & 0xFFFFFFFF

    def next(self) -> float:
        self.state = (self.state + 0x6D2B79F5) & 0xFFFFFFFF
        t = (self.state ^ (self.state >> 15)) * (1 | self.state)
        t &= 0xFFFFFFFF
        t ^= (t + ((t ^ (t >> 7)) * (61 | t))) & 0xFFFFFFFF
        t &= 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    def next_range(self, minimum: float, maximum: float) -> float:
        return minimum + (maximum - minimum) * self.next()


class Vec3:
    __slots__ = ("x", "y", "z")

    def __init__(self, x: float, y: float, z: float) -> None:
        self.x = x
        self.y = y
        self.z = z

    @staticmethod
    def empty() -> "Vec3":
        return Vec3(0.0, 0.0, 0.0)

    @staticmethod
    def random(rng: RandomSource, minimum: float = 0.0, maximum: float = 1.0) -> "Vec3":
        return Vec3(
            rng.next_range(minimum, maximum),
            rng.next_range(minimum, maximum),
            rng.next_range(minimum, maximum),
        )

    @staticmethod
    def random_unit_vector(rng: RandomSource) -> "Vec3":
        while True:
            p = Vec3.random(rng, -1.0, 1.0)
            lensq = p.len_squared()
            if 1e-160 < lensq <= 1.0:
                return p.div_scalar(math.sqrt(lensq))

    @staticmethod
    def random_in_unit_disk(rng: RandomSource) -> "Vec3":
        while True:
            p = Vec3(rng.next_range(-1.0, 1.0), rng.next_range(-1.0, 1.0), 0.0)
            if p.len_squared() < 1.0:
                return p

    def set(self, other: "Vec3") -> None:
        self.x = other.x
        self.y = other.y
        self.z = other.z

    def add(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x + other.x, self.y + other.y, self.z + other.z)

    def add_in_place(self, other: "Vec3") -> None:
        self.x += other.x
        self.y += other.y
        self.z += other.z

    def sub(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x - other.x, self.y - other.y, self.z - other.z)

    def neg(self) -> "Vec3":
        return Vec3(-self.x, -self.y, -self.z)

    def mul_vec(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x * other.x, self.y * other.y, self.z * other.z)

    def mul_scalar(self, scalar: float) -> "Vec3":
        return Vec3(self.x * scalar, self.y * scalar, self.z * scalar)

    def div_scalar(self, scalar: float) -> "Vec3":
        return Vec3(self.x / scalar, self.y / scalar, self.z / scalar)

    def cross(self, other: "Vec3") -> "Vec3":
        return Vec3(
            self.y * other.z - self.z * other.y,
            self.z * other.x - self.x * other.z,
            self.x * other.y - self.y * other.x,
        )

    def dot(self, other: "Vec3") -> float:
        return self.x * other.x + self.y * other.y + self.z * other.z

    def len(self) -> float:
        return math.sqrt(self.len_squared())

    def len_squared(self) -> float:
        return self.x * self.x + self.y * self.y + self.z * self.z

    def near_zero(self) -> bool:
        return abs(self.x) < 1e-8 and abs(self.y) < 1e-8 and abs(self.z) < 1e-8

    def unit_vector(self) -> "Vec3":
        return self.div_scalar(self.len())

    def reflect(self, normal: "Vec3") -> "Vec3":
        return self.sub(normal.mul_scalar(2.0 * self.dot(normal)))

    def refract(self, normal: "Vec3", etai_over_etat: float) -> "Vec3":
        cos_theta = min(self.neg().dot(normal), 1.0)
        r_out_perp = self.add(normal.mul_scalar(cos_theta)).mul_scalar(etai_over_etat)
        r_out_parallel = normal.mul_scalar(-math.sqrt(abs(1.0 - r_out_perp.len_squared())))
        return r_out_perp.add(r_out_parallel)


Point3 = Vec3
Color = Vec3


class Ray:
    __slots__ = ("origin", "direction")

    def __init__(self, origin: Vec3, direction: Vec3) -> None:
        self.origin = origin
        self.direction = direction

    @staticmethod
    def empty() -> "Ray":
        return Ray(Vec3.empty(), Vec3.empty())

    def at(self, t: float) -> Vec3:
        return self.origin.add(self.direction.mul_scalar(t))

    def set(self, other: "Ray") -> None:
        self.origin = other.origin
        self.direction = other.direction


class Interval:
    __slots__ = ("minimum", "maximum")

    def __init__(self, minimum: float, maximum: float) -> None:
        self.minimum = minimum
        self.maximum = maximum

    def clamp(self, x: float) -> float:
        if x < self.minimum:
            return self.minimum
        if x > self.maximum:
            return self.maximum
        return x

    def surrounds(self, x: float) -> bool:
        return self.minimum < x < self.maximum


class ScatterTarget:
    __slots__ = ("attenuation", "scattered")

    def __init__(self) -> None:
        self.attenuation = Vec3.empty()
        self.scattered = Ray.empty()


class Material(Protocol):
    def scatter(self, r_in: Ray, rec: "HitRecord", target: ScatterTarget, rng: RandomSource) -> bool:
        ...


class Lambertian:
    __slots__ = ("albedo",)

    def __init__(self, albedo: Color) -> None:
        self.albedo = albedo

    def scatter(self, _r_in: Ray, rec: "HitRecord", target: ScatterTarget, rng: RandomSource) -> bool:
        scatter_direction = rec.normal.add(Vec3.random_unit_vector(rng))
        if scatter_direction.near_zero():
            scatter_direction = rec.normal
        target.scattered.set(Ray(rec.p, scatter_direction))
        target.attenuation.set(self.albedo)
        return True


class Metal:
    __slots__ = ("albedo", "fuzz")

    def __init__(self, albedo: Color, fuzz: float) -> None:
        self.albedo = albedo
        self.fuzz = fuzz

    def scatter(self, r_in: Ray, rec: "HitRecord", target: ScatterTarget, rng: RandomSource) -> bool:
        reflected = r_in.direction.reflect(rec.normal)
        reflected = reflected.unit_vector().add(Vec3.random_unit_vector(rng).mul_scalar(self.fuzz))
        target.scattered.set(Ray(rec.p, reflected))
        target.attenuation.set(self.albedo)
        return True


class Dielectric:
    __slots__ = ("refraction_index",)

    def __init__(self, refraction_index: float) -> None:
        self.refraction_index = refraction_index

    def scatter(self, r_in: Ray, rec: "HitRecord", target: ScatterTarget, rng: RandomSource) -> bool:
        target.attenuation.set(Vec3(1.0, 1.0, 1.0))
        ri = 1.0 / self.refraction_index if rec.front_face else self.refraction_index
        unit_direction = r_in.direction.unit_vector()
        cos_theta = min(unit_direction.neg().dot(rec.normal), 1.0)
        sin_theta = math.sqrt(1.0 - cos_theta * cos_theta)
        cannot_refract = ri * sin_theta > 1.0
        direction = (
            unit_direction.reflect(rec.normal)
            if cannot_refract or self.reflectance(cos_theta) > rng.next()
            else unit_direction.refract(rec.normal, ri)
        )
        target.scattered.set(Ray(rec.p, direction))
        return True

    def reflectance(self, cosine: float) -> float:
        r0 = (1.0 - self.refraction_index) / (1.0 + self.refraction_index)
        r0 *= r0
        return r0 + (1.0 - r0) * math.pow(1.0 - cosine, 5.0)


class HitRecord:
    __slots__ = ("p", "normal", "mat", "t", "front_face")

    def __init__(self) -> None:
        self.p = Vec3(0.0, 0.0, 0.0)
        self.normal = Vec3(0.0, 0.0, 0.0)
        self.mat: Material = Lambertian(Vec3(0.0, 0.0, 0.0))
        self.t = 0.0
        self.front_face = False

    def set(self, other: "HitRecord") -> None:
        self.p = other.p
        self.normal = other.normal
        self.mat = other.mat
        self.t = other.t
        self.front_face = other.front_face

    def set_face_normal(self, ray: Ray, outward_normal: Vec3) -> None:
        self.front_face = ray.direction.dot(outward_normal) < 0.0
        self.normal = outward_normal if self.front_face else outward_normal.mul_scalar(-1.0)


class Hittable(Protocol):
    def hit(self, ray: Ray, ray_t: Interval, rec: HitRecord) -> bool: ...


class Sphere:
    __slots__ = ("center", "radius", "mat")

    def __init__(self, center: Point3, radius: float, mat: Material) -> None:
        self.center = center
        self.radius = radius
        self.mat = mat

    def hit(self, ray: Ray, ray_t: Interval, rec: HitRecord) -> bool:
        oc = self.center.sub(ray.origin)
        a = ray.direction.len_squared()
        h = ray.direction.dot(oc)
        c = oc.len_squared() - self.radius * self.radius
        discriminant = h * h - a * c
        if discriminant < 0.0:
            return False

        sqrtd = math.sqrt(discriminant)
        root = (h - sqrtd) / a
        if not ray_t.surrounds(root):
            root = (h + sqrtd) / a
            if not ray_t.surrounds(root):
                return False

        rec.t = root
        rec.p = ray.at(rec.t)
        rec.mat = self.mat
        outward_normal = rec.p.sub(self.center).div_scalar(self.radius)
        rec.set_face_normal(ray, outward_normal)
        return True


class HittableList:
    __slots__ = ("objects",)

    def __init__(self) -> None:
        self.objects: list[Hittable] = []

    def add(self, obj: Hittable) -> None:
        self.objects.append(obj)

    def hit(self, ray: Ray, ray_t: Interval, rec: HitRecord) -> bool:
        temp_rec = HitRecord()
        hit_anything = False
        closest_so_far = ray_t.maximum

        for obj in self.objects:
            if obj.hit(ray, Interval(ray_t.minimum, closest_so_far), temp_rec):
                hit_anything = True
                closest_so_far = temp_rec.t
                rec.set(temp_rec)

        return hit_anything


class Camera:
    __slots__ = (
        "aspect_ratio",
        "image_width",
        "samples_per_pixel",
        "max_depth",
        "image_height",
        "center",
        "pixel_samples_scale",
        "pixel00_loc",
        "pixel_delta_u",
        "pixel_delta_v",
        "u",
        "v",
        "w",
        "defocus_angle",
        "defocus_disk_u",
        "defocus_disk_v",
    )

    def __init__(
        self,
        *,
        aspect_ratio: float,
        image_width: int,
        samples_per_pixel: int,
        max_depth: int,
        look_from: Point3,
        look_at: Point3,
        vup: Vec3,
        vfov: float,
        defocus_angle: float,
        focus_dist: float,
    ) -> None:
        self.aspect_ratio = aspect_ratio
        self.image_width = image_width
        self.samples_per_pixel = samples_per_pixel
        self.max_depth = max_depth
        self.image_height = max(1, int(image_width / aspect_ratio))
        self.center = look_from

        theta = degrees_to_radians(vfov)
        h = math.tan(theta / 2.0)
        viewport_height = 2.0 * h * focus_dist
        viewport_width = viewport_height * (image_width / self.image_height)

        self.w = look_from.sub(look_at).unit_vector()
        self.u = vup.cross(self.w)
        self.v = self.w.cross(self.u)

        viewport_u = self.u.mul_scalar(viewport_width)
        viewport_v = self.v.mul_scalar(-viewport_height)

        self.pixel_delta_u = viewport_u.div_scalar(image_width)
        self.pixel_delta_v = viewport_v.div_scalar(self.image_height)

        viewport_upper_left = (
            self.center
            .sub(self.w.mul_scalar(focus_dist))
            .sub(viewport_u.div_scalar(2.0))
            .sub(viewport_v.div_scalar(2.0))
        )

        self.pixel00_loc = viewport_upper_left.add(
            self.pixel_delta_u.add(self.pixel_delta_v).mul_scalar(0.5)
        )
        self.pixel_samples_scale = 1.0 / samples_per_pixel
        self.defocus_angle = defocus_angle

        defocus_radius = focus_dist * math.tan(degrees_to_radians(defocus_angle / 2.0))
        self.defocus_disk_u = self.u.mul_scalar(defocus_radius)
        self.defocus_disk_v = self.v.mul_scalar(defocus_radius)

    def render(self, world: Hittable, rng: RandomSource, output: TextIO) -> None:
        output.write(f"P3\n{self.image_width} {self.image_height}\n255\n")

        for j in range(self.image_height):
            sys.stderr.write(f"\rScanlines remaining: {self.image_height - j}")
            scanline: list[str] = []
            for i in range(self.image_width):
                color = Vec3(1.0, 1.0, 1.0)
                for _ in range(self.samples_per_pixel):
                    ray = self.get_ray(i, j, rng)
                    color.add_in_place(ray_color(ray, self.max_depth, world, rng))
                scanline.append(color_to_line(color.mul_scalar(self.pixel_samples_scale)))
            output.write("".join(scanline))

        sys.stderr.write("\n")

    def get_ray(self, i: int, j: int, rng: RandomSource) -> Ray:
        offset = sample_square(rng)
        pixel_sample = (
            self.pixel00_loc
            .add(self.pixel_delta_u.mul_scalar(i + offset.x))
            .add(self.pixel_delta_v.mul_scalar(j + offset.y))
        )
        ray_origin = self.center if self.defocus_angle <= 0.0 else self.defocus_disk_sample(rng)
        ray_direction = pixel_sample.sub(ray_origin)
        return Ray(ray_origin, ray_direction)

    def defocus_disk_sample(self, rng: RandomSource) -> Point3:
        p = Vec3.random_in_unit_disk(rng)
        return self.center.add(self.defocus_disk_u.mul_scalar(p.x)).add(
            self.defocus_disk_v.mul_scalar(p.y)
        )


EMPTY = Vec3(0.0, 0.0, 0.0)
ONE = Vec3(1.0, 1.0, 1.0)
SKY = Vec3(0.5, 0.7, 1.0)
RAY_T = Interval(0.001, math.inf)
INTENSITY = Interval(0.0, 0.999)


def degrees_to_radians(degrees: float) -> float:
    return degrees * math.pi / 180.0


def sample_square(rng: RandomSource) -> Vec3:
    return Vec3(rng.next() - 0.5, rng.next() - 0.5, 0.0)


def ray_color(ray: Ray, depth: int, world: Hittable, rng: RandomSource) -> Color:
    if depth <= 0:
        return EMPTY

    rec = HitRecord()
    if world.hit(ray, RAY_T, rec):
        target = ScatterTarget()
        if rec.mat.scatter(ray, rec, target, rng):
            return target.attenuation.mul_vec(ray_color(target.scattered, depth - 1, world, rng))
        return Vec3(0.0, 0.0, 0.0)

    unit_direction = ray.direction.unit_vector()
    a = 0.5 * (unit_direction.y + 1.0)
    return ONE.mul_scalar(1.0 - a).add(SKY.mul_scalar(a))


def linear_to_gamma(linear_component: float) -> float:
    return math.sqrt(linear_component) if linear_component > 0.0 else 0.0


def to_pixel(color: float) -> int:
    return math.trunc(256.0 * INTENSITY.clamp(linear_to_gamma(color)))


def color_to_line(color: Color) -> str:
    return f"{to_pixel(color.x)} {to_pixel(color.y)} {to_pixel(color.z)}\n"


def render_vtrace(
    *,
    image_width: int = 300,
    samples_per_pixel: int = 20,
    max_depth: int = 50,
    out_path: Optional[str] = None,
    seed: Optional[int] = None,
) -> None:
    rng: RandomSource = MathRandom() if seed is None else Mulberry32Random(seed)
    world = HittableList()
    ground_material = Lambertian(Vec3(0.5, 0.5, 0.5))
    world.add(Sphere(Vec3(0.0, -1000.0, 0.0), 1000.0, ground_material))

    for a in range(-11, 11):
        for b in range(-11, 11):
            choose_mat = rng.next()
            center = Vec3(a + 0.9 * rng.next(), 0.2, b + 0.9 * rng.next())

            if center.sub(Vec3(4.0, 0.2, 0.0)).len() > 0.9:
                if choose_mat < 0.8:
                    albedo = Vec3.random(rng).mul_vec(Vec3.random(rng))
                    world.add(Sphere(center, 0.2, Lambertian(albedo)))
                elif choose_mat < 0.95:
                    albedo = Vec3.random(rng, 0.5, 1.0)
                    fuzz = rng.next_range(0.0, 0.5)
                    world.add(Sphere(center, 0.2, Metal(albedo, fuzz)))
                else:
                    world.add(Sphere(center, 0.2, Dielectric(1.5)))

    world.add(Sphere(Vec3(0.0, 1.0, 0.0), 1.0, Dielectric(1.5)))
    world.add(Sphere(Vec3(-4.0, 1.0, 0.0), 1.0, Lambertian(Vec3(0.4, 0.3, 0.2))))
    world.add(Sphere(Vec3(4.0, 1.0, 0.0), 1.0, Metal(Vec3(0.7, 0.6, 0.5), 0.0)))

    camera = Camera(
        aspect_ratio=16.0 / 9.0,
        image_width=image_width,
        samples_per_pixel=samples_per_pixel,
        max_depth=max_depth,
        look_from=Vec3(13.0, 2.0, 3.0),
        look_at=Vec3(0.0, 0.0, 0.0),
        vup=Vec3(0.0, 1.0, 0.0),
        vfov=20.0,
        defocus_angle=0.6,
        focus_dist=10.0,
    )

    if out_path is None:
        camera.render(world, rng, sys.stdout)
        return

    with open(out_path, "w", encoding="utf8") as output:
        camera.render(world, rng, output)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--image-width", type=int)
    parser.add_argument("--samples-per-pixel", type=int)
    parser.add_argument("--max-depth", type=int)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    render_vtrace(
        image_width=args.image_width or 200,
        samples_per_pixel=args.samples_per_pixel or 10,
        max_depth=args.max_depth or 50,
        out_path=args.out,
        seed=args.seed,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as error:  # pragma: no cover
        sys.stderr.write(f"{error}\n")
        raise
