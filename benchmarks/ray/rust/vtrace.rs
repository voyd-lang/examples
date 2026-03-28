use std::env;
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::time::{SystemTime, UNIX_EPOCH};

trait RandomSource {
    fn next(&mut self) -> f64;

    fn next_range(&mut self, min: f64, max: f64) -> f64 {
        min + (max - min) * self.next()
    }
}

struct Mulberry32Random {
    state: u32,
}

impl Mulberry32Random {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }
}

impl RandomSource for Mulberry32Random {
    fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6D2B79F5);
        let mut t = (self.state ^ (self.state >> 15)).wrapping_mul(1 | self.state);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

#[derive(Clone, Copy, Debug)]
struct Vec3 {
    x: f64,
    y: f64,
    z: f64,
}

impl Vec3 {
    fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    fn zero() -> Self {
        Self::new(0.0, 0.0, 0.0)
    }

    fn random(rng: &mut dyn RandomSource, min: f64, max: f64) -> Self {
        Self::new(
            rng.next_range(min, max),
            rng.next_range(min, max),
            rng.next_range(min, max),
        )
    }

    fn random_unit_vector(rng: &mut dyn RandomSource) -> Self {
        loop {
            let p = Self::random(rng, -1.0, 1.0);
            let lensq = p.len_squared();
            if lensq > 1e-160 && lensq <= 1.0 {
                return p.div_scalar(lensq.sqrt());
            }
        }
    }

    fn random_in_unit_disk(rng: &mut dyn RandomSource) -> Self {
        loop {
            let p = Self::new(rng.next_range(-1.0, 1.0), rng.next_range(-1.0, 1.0), 0.0);
            if p.len_squared() < 1.0 {
                return p;
            }
        }
    }

    fn add(self, other: Self) -> Self {
        Self::new(self.x + other.x, self.y + other.y, self.z + other.z)
    }

    fn sub(self, other: Self) -> Self {
        Self::new(self.x - other.x, self.y - other.y, self.z - other.z)
    }

    fn neg(self) -> Self {
        Self::new(-self.x, -self.y, -self.z)
    }

    fn mul_vec(self, other: Self) -> Self {
        Self::new(self.x * other.x, self.y * other.y, self.z * other.z)
    }

    fn mul_scalar(self, scalar: f64) -> Self {
        Self::new(self.x * scalar, self.y * scalar, self.z * scalar)
    }

    fn div_scalar(self, scalar: f64) -> Self {
        Self::new(self.x / scalar, self.y / scalar, self.z / scalar)
    }

    fn cross(self, other: Self) -> Self {
        Self::new(
            self.y * other.z - self.z * other.y,
            self.z * other.x - self.x * other.z,
            self.x * other.y - self.y * other.x,
        )
    }

    fn dot(self, other: Self) -> f64 {
        self.x * other.x + self.y * other.y + self.z * other.z
    }

    fn len(self) -> f64 {
        self.len_squared().sqrt()
    }

    fn len_squared(self) -> f64 {
        self.x * self.x + self.y * self.y + self.z * self.z
    }

    fn near_zero(self) -> bool {
        self.x.abs() < 1e-8 && self.y.abs() < 1e-8 && self.z.abs() < 1e-8
    }

    fn unit_vector(self) -> Self {
        self.div_scalar(self.len())
    }

    fn reflect(self, normal: Self) -> Self {
        self.sub(normal.mul_scalar(2.0 * self.dot(normal)))
    }

    fn refract(self, normal: Self, etai_over_etat: f64) -> Self {
        let cos_theta = self.neg().dot(normal).min(1.0);
        let r_out_perp = self.add(normal.mul_scalar(cos_theta)).mul_scalar(etai_over_etat);
        let r_out_parallel = normal.mul_scalar(-(1.0 - r_out_perp.len_squared()).abs().sqrt());
        r_out_perp.add(r_out_parallel)
    }
}

type Point3 = Vec3;
type Color = Vec3;

#[derive(Clone, Copy)]
struct Ray {
    origin: Vec3,
    direction: Vec3,
}

impl Ray {
    fn new(origin: Vec3, direction: Vec3) -> Self {
        Self { origin, direction }
    }

    fn at(self, t: f64) -> Vec3 {
        self.origin.add(self.direction.mul_scalar(t))
    }
}

#[derive(Clone, Copy)]
struct Interval {
    min: f64,
    max: f64,
}

impl Interval {
    fn new(min: f64, max: f64) -> Self {
        Self { min, max }
    }

    fn clamp(self, x: f64) -> f64 {
        if x < self.min {
            self.min
        } else if x > self.max {
            self.max
        } else {
            x
        }
    }

    fn surrounds(self, x: f64) -> bool {
        self.min < x && x < self.max
    }
}

#[derive(Clone, Copy)]
enum Material {
    Lambertian { albedo: Color },
    Metal { albedo: Color, fuzz: f64 },
    Dielectric { refraction_index: f64 },
}

#[derive(Clone, Copy)]
struct ScatterTarget {
    attenuation: Vec3,
    scattered: Ray,
}

#[derive(Clone, Copy)]
struct HitRecord {
    p: Vec3,
    normal: Vec3,
    mat: Material,
    t: f64,
    front_face: bool,
}

impl HitRecord {
    fn new() -> Self {
        Self {
            p: Vec3::zero(),
            normal: Vec3::zero(),
            mat: Material::Lambertian {
                albedo: Vec3::zero(),
            },
            t: 0.0,
            front_face: false,
        }
    }

    fn set_face_normal(&mut self, ray: Ray, outward_normal: Vec3) {
        self.front_face = ray.direction.dot(outward_normal) < 0.0;
        self.normal = if self.front_face {
            outward_normal
        } else {
            outward_normal.mul_scalar(-1.0)
        };
    }
}

impl Material {
    fn scatter(
        self,
        r_in: Ray,
        rec: &HitRecord,
        rng: &mut dyn RandomSource,
    ) -> Option<ScatterTarget> {
        match self {
            Material::Lambertian { albedo } => {
                let mut scatter_direction = rec.normal.add(Vec3::random_unit_vector(rng));
                if scatter_direction.near_zero() {
                    scatter_direction = rec.normal;
                }
                Some(ScatterTarget {
                    attenuation: albedo,
                    scattered: Ray::new(rec.p, scatter_direction),
                })
            }
            Material::Metal { albedo, fuzz } => {
                let reflected = r_in
                    .direction
                    .reflect(rec.normal)
                    .unit_vector()
                    .add(Vec3::random_unit_vector(rng).mul_scalar(fuzz));
                Some(ScatterTarget {
                    attenuation: albedo,
                    scattered: Ray::new(rec.p, reflected),
                })
            }
            Material::Dielectric { refraction_index } => {
                let ri = if rec.front_face {
                    1.0 / refraction_index
                } else {
                    refraction_index
                };
                let unit_direction = r_in.direction.unit_vector();
                let cos_theta = unit_direction.neg().dot(rec.normal).min(1.0);
                let sin_theta = (1.0 - cos_theta * cos_theta).sqrt();
                let cannot_refract = ri * sin_theta > 1.0;
                let direction = if cannot_refract || reflectance(cos_theta, refraction_index) > rng.next() {
                    unit_direction.reflect(rec.normal)
                } else {
                    unit_direction.refract(rec.normal, ri)
                };
                Some(ScatterTarget {
                    attenuation: Vec3::new(1.0, 1.0, 1.0),
                    scattered: Ray::new(rec.p, direction),
                })
            }
        }
    }
}

#[derive(Clone, Copy)]
struct Sphere {
    center: Point3,
    radius: f64,
    mat: Material,
}

impl Sphere {
    fn hit(self, ray: Ray, ray_t: Interval, rec: &mut HitRecord) -> bool {
        let oc = self.center.sub(ray.origin);
        let a = ray.direction.len_squared();
        let h = ray.direction.dot(oc);
        let c = oc.len_squared() - self.radius * self.radius;
        let discriminant = h * h - a * c;
        if discriminant < 0.0 {
            return false;
        }

        let sqrtd = discriminant.sqrt();
        let mut root = (h - sqrtd) / a;
        if !ray_t.surrounds(root) {
            root = (h + sqrtd) / a;
            if !ray_t.surrounds(root) {
                return false;
            }
        }

        rec.t = root;
        rec.p = ray.at(rec.t);
        rec.mat = self.mat;
        let outward_normal = rec.p.sub(self.center).div_scalar(self.radius);
        rec.set_face_normal(ray, outward_normal);
        true
    }
}

struct HittableList {
    objects: Vec<Sphere>,
}

impl HittableList {
    fn new() -> Self {
        Self { objects: Vec::new() }
    }

    fn add(&mut self, obj: Sphere) {
        self.objects.push(obj);
    }

    fn hit(&self, ray: Ray, ray_t: Interval, rec: &mut HitRecord) -> bool {
        let mut temp_rec = HitRecord::new();
        let mut hit_anything = false;
        let mut closest_so_far = ray_t.max;

        for object in &self.objects {
            if object.hit(ray, Interval::new(ray_t.min, closest_so_far), &mut temp_rec) {
                hit_anything = true;
                closest_so_far = temp_rec.t;
                *rec = temp_rec;
            }
        }

        hit_anything
    }
}

struct Camera {
    image_width: usize,
    image_height: usize,
    samples_per_pixel: usize,
    max_depth: i32,
    center: Point3,
    pixel_samples_scale: f64,
    pixel00_loc: Point3,
    pixel_delta_u: Vec3,
    pixel_delta_v: Vec3,
    defocus_angle: f64,
    defocus_disk_u: Vec3,
    defocus_disk_v: Vec3,
}

impl Camera {
    fn new(
        aspect_ratio: f64,
        image_width: usize,
        samples_per_pixel: usize,
        max_depth: i32,
        look_from: Point3,
        look_at: Point3,
        vup: Vec3,
        vfov: f64,
        defocus_angle: f64,
        focus_dist: f64,
    ) -> Self {
        let image_height = usize::max(1, (image_width as f64 / aspect_ratio) as usize);
        let center = look_from;

        let theta = degrees_to_radians(vfov);
        let h = (theta / 2.0).tan();
        let viewport_height = 2.0 * h * focus_dist;
        let viewport_width = viewport_height * (image_width as f64 / image_height as f64);

        let w = look_from.sub(look_at).unit_vector();
        let u = vup.cross(w);
        let v = w.cross(u);

        let viewport_u = u.mul_scalar(viewport_width);
        let viewport_v = v.mul_scalar(-viewport_height);

        let pixel_delta_u = viewport_u.div_scalar(image_width as f64);
        let pixel_delta_v = viewport_v.div_scalar(image_height as f64);

        let viewport_upper_left = center
            .sub(w.mul_scalar(focus_dist))
            .sub(viewport_u.div_scalar(2.0))
            .sub(viewport_v.div_scalar(2.0));

        let pixel00_loc =
            viewport_upper_left.add(pixel_delta_u.add(pixel_delta_v).mul_scalar(0.5));
        let pixel_samples_scale = 1.0 / samples_per_pixel as f64;

        let defocus_radius = focus_dist * degrees_to_radians(defocus_angle / 2.0).tan();
        let defocus_disk_u = u.mul_scalar(defocus_radius);
        let defocus_disk_v = v.mul_scalar(defocus_radius);

        Self {
            image_width,
            image_height,
            samples_per_pixel,
            max_depth,
            center,
            pixel_samples_scale,
            pixel00_loc,
            pixel_delta_u,
            pixel_delta_v,
            defocus_angle,
            defocus_disk_u,
            defocus_disk_v,
        }
    }

    fn render(
        &self,
        world: &HittableList,
        rng: &mut dyn RandomSource,
        output: &mut dyn Write,
    ) -> io::Result<()> {
        write!(output, "P3\n{} {}\n255\n", self.image_width, self.image_height)?;

        for j in 0..self.image_height {
            eprint!("\rScanlines remaining: {}", self.image_height - j);
            let mut scanline = String::new();
            for i in 0..self.image_width {
                let mut color = Vec3::new(1.0, 1.0, 1.0);
                for _ in 0..self.samples_per_pixel {
                    let ray = self.get_ray(i, j, rng);
                    color = color.add(ray_color(ray, self.max_depth, world, rng));
                }
                scanline.push_str(&color_to_line(color.mul_scalar(self.pixel_samples_scale)));
            }
            output.write_all(scanline.as_bytes())?;
        }

        eprintln!();
        output.flush()
    }

    fn get_ray(&self, i: usize, j: usize, rng: &mut dyn RandomSource) -> Ray {
        let offset = sample_square(rng);
        let pixel_sample = self
            .pixel00_loc
            .add(self.pixel_delta_u.mul_scalar(i as f64 + offset.x))
            .add(self.pixel_delta_v.mul_scalar(j as f64 + offset.y));
        let ray_origin = if self.defocus_angle <= 0.0 {
            self.center
        } else {
            self.defocus_disk_sample(rng)
        };
        let ray_direction = pixel_sample.sub(ray_origin);
        Ray::new(ray_origin, ray_direction)
    }

    fn defocus_disk_sample(&self, rng: &mut dyn RandomSource) -> Point3 {
        let p = Vec3::random_in_unit_disk(rng);
        self.center
            .add(self.defocus_disk_u.mul_scalar(p.x))
            .add(self.defocus_disk_v.mul_scalar(p.y))
    }
}

fn degrees_to_radians(degrees: f64) -> f64 {
    degrees * std::f64::consts::PI / 180.0
}

fn sample_square(rng: &mut dyn RandomSource) -> Vec3 {
    Vec3::new(rng.next() - 0.5, rng.next() - 0.5, 0.0)
}

fn reflectance(cosine: f64, refraction_index: f64) -> f64 {
    let mut r0 = (1.0 - refraction_index) / (1.0 + refraction_index);
    r0 *= r0;
    r0 + (1.0 - r0) * (1.0 - cosine).powi(5)
}

fn ray_color(ray: Ray, depth: i32, world: &HittableList, rng: &mut dyn RandomSource) -> Color {
    if depth <= 0 {
        return Vec3::zero();
    }

    let mut rec = HitRecord::new();
    if world.hit(ray, Interval::new(0.001, f64::INFINITY), &mut rec) {
        if let Some(target) = rec.mat.scatter(ray, &rec, rng) {
            return target
                .attenuation
                .mul_vec(ray_color(target.scattered, depth - 1, world, rng));
        }
        return Vec3::zero();
    }

    let unit_direction = ray.direction.unit_vector();
    let a = 0.5 * (unit_direction.y + 1.0);
    Vec3::new(1.0, 1.0, 1.0)
        .mul_scalar(1.0 - a)
        .add(Vec3::new(0.5, 0.7, 1.0).mul_scalar(a))
}

fn linear_to_gamma(linear_component: f64) -> f64 {
    if linear_component > 0.0 {
        linear_component.sqrt()
    } else {
        0.0
    }
}

fn to_pixel(color: f64) -> i32 {
    (256.0 * Interval::new(0.0, 0.999).clamp(linear_to_gamma(color))).trunc() as i32
}

fn color_to_line(color: Color) -> String {
    format!(
        "{} {} {}\n",
        to_pixel(color.x),
        to_pixel(color.y),
        to_pixel(color.z)
    )
}

struct RenderOptions {
    image_width: usize,
    samples_per_pixel: usize,
    max_depth: i32,
    out_path: Option<String>,
    seed: Option<u32>,
}

fn render_vtrace(options: RenderOptions) -> io::Result<()> {
    let seed = options.seed.unwrap_or_else(default_seed);
    let mut rng = Mulberry32Random::new(seed);

    let mut world = HittableList::new();
    world.add(Sphere {
        center: Vec3::new(0.0, -1000.0, 0.0),
        radius: 1000.0,
        mat: Material::Lambertian {
            albedo: Vec3::new(0.5, 0.5, 0.5),
        },
    });

    for a in -11..11 {
        for b in -11..11 {
            let choose_mat = rng.next();
            let center = Vec3::new(
                a as f64 + 0.9 * rng.next(),
                0.2,
                b as f64 + 0.9 * rng.next(),
            );

            if center.sub(Vec3::new(4.0, 0.2, 0.0)).len() > 0.9 {
                if choose_mat < 0.8 {
                    let albedo = Vec3::random(&mut rng, 0.0, 1.0).mul_vec(Vec3::random(
                        &mut rng,
                        0.0,
                        1.0,
                    ));
                    world.add(Sphere {
                        center,
                        radius: 0.2,
                        mat: Material::Lambertian { albedo },
                    });
                } else if choose_mat < 0.95 {
                    let albedo = Vec3::random(&mut rng, 0.5, 1.0);
                    let fuzz = rng.next_range(0.0, 0.5);
                    world.add(Sphere {
                        center,
                        radius: 0.2,
                        mat: Material::Metal { albedo, fuzz },
                    });
                } else {
                    world.add(Sphere {
                        center,
                        radius: 0.2,
                        mat: Material::Dielectric {
                            refraction_index: 1.5,
                        },
                    });
                }
            }
        }
    }

    world.add(Sphere {
        center: Vec3::new(0.0, 1.0, 0.0),
        radius: 1.0,
        mat: Material::Dielectric {
            refraction_index: 1.5,
        },
    });
    world.add(Sphere {
        center: Vec3::new(-4.0, 1.0, 0.0),
        radius: 1.0,
        mat: Material::Lambertian {
            albedo: Vec3::new(0.4, 0.3, 0.2),
        },
    });
    world.add(Sphere {
        center: Vec3::new(4.0, 1.0, 0.0),
        radius: 1.0,
        mat: Material::Metal {
            albedo: Vec3::new(0.7, 0.6, 0.5),
            fuzz: 0.0,
        },
    });

    let camera = Camera::new(
        16.0 / 9.0,
        options.image_width,
        options.samples_per_pixel,
        options.max_depth,
        Vec3::new(13.0, 2.0, 3.0),
        Vec3::new(0.0, 0.0, 0.0),
        Vec3::new(0.0, 1.0, 0.0),
        20.0,
        0.6,
        10.0,
    );

    match options.out_path {
        Some(path) => {
            let file = File::create(path)?;
            let mut output = BufWriter::new(file);
            camera.render(&world, &mut rng, &mut output)
        }
        None => {
            let stdout = io::stdout();
            let mut output = BufWriter::new(stdout.lock());
            camera.render(&world, &mut rng, &mut output)
        }
    }
}

fn default_seed() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos())
        .unwrap_or(1)
}

fn parse_args() -> RenderOptions {
    let mut options = RenderOptions {
        image_width: 300,
        samples_per_pixel: 20,
        max_depth: 50,
        out_path: None,
        seed: None,
    };

    let args: Vec<String> = env::args().skip(1).collect();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        let next = args.get(index + 1);
        match (arg.as_str(), next) {
            ("--out", Some(value)) => {
                options.out_path = Some(value.clone());
                index += 2;
            }
            ("--seed", Some(value)) => {
                options.seed = value.parse::<u32>().ok();
                index += 2;
            }
            ("--image-width", Some(value)) => {
                if let Ok(parsed) = value.parse::<usize>() {
                    options.image_width = parsed;
                }
                index += 2;
            }
            ("--samples-per-pixel", Some(value)) => {
                if let Ok(parsed) = value.parse::<usize>() {
                    options.samples_per_pixel = parsed;
                }
                index += 2;
            }
            ("--max-depth", Some(value)) => {
                if let Ok(parsed) = value.parse::<i32>() {
                    options.max_depth = parsed;
                }
                index += 2;
            }
            _ => {
                index += 1;
            }
        }
    }

    options
}

fn main() {
    if let Err(error) = render_vtrace(parse_args()) {
        eprintln!("{}", error);
        std::process::exit(1);
    }
}
