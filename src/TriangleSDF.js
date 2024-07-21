import { Vector3, DataTexture, RGBAFormat, FloatType } from "three";
import RayTracingMaterial from "./RayTracingMaterial";

export default class TriangleSDF {
    constructor(posA, posB, posC, normalA, normalB, normalC, material) {
        this.posA = posA;
        this.posB = posB;
        this.posC = posC;
        this.normalA = normalA;
        this.normalB = normalB;
        this.normalC = normalC;
        this.material = material;
    }
}

export function extractTrianglesFromMeshes(meshes) {
    const triangles = [];
    meshes.forEach(mesh => {
        const geometry = mesh.geometry.rotateX(-Math.PI / 2).rotateY(-Math.PI / 2).translate(0, -1, -5);
        const positions = geometry.attributes.position.array;
        const normals = geometry.attributes.normal.array;
        const count = geometry.attributes.position.count;

        for (let i = 0; i < count; i += 3) {
            const posA = new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
            const posB = new Vector3(positions[(i + 1) * 3], positions[(i + 1) * 3 + 1], positions[(i + 1) * 3 + 2]);
            const posC = new Vector3(positions[(i + 2) * 3], positions[(i + 2) * 3 + 1], positions[(i + 2) * 3 + 2]);

            const normalA = new Vector3(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
            const normalB = new Vector3(normals[(i + 1) * 3], normals[(i + 1) * 3 + 1], normals[(i + 1) * 3 + 2]);
            const normalC = new Vector3(normals[(i + 2) * 3], normals[(i + 2) * 3 + 1], normals[(i + 2) * 3 + 2]);

            const triangle = new TriangleSDF(posA, posB, posC, normalA, normalB, normalC, new RayTracingMaterial());
            triangles.push(triangle);
        }
    });
    return triangles;
}

export function createTriangleTexture(triangles) {
    const texWidth = 2048;
    const texHeight = Math.ceil(triangles.length / texWidth);
    const data = new Float32Array(texWidth * texHeight * 4 * 3);

    triangles.forEach((triangle, i) => {
        const offset = i * 12;
        data.set([triangle.posA.x, triangle.posA.y, triangle.posA.z, 0], offset);
        data.set([triangle.posB.x, triangle.posB.y, triangle.posB.z, 0], offset + 4);
        data.set([triangle.posC.x, triangle.posC.y, triangle.posC.z, 0], offset + 8);
    });

    const texture = new DataTexture(data, texWidth, texHeight, RGBAFormat, FloatType);
    texture.needsUpdate = true;
    return texture;
}

export function createNormalTexture(triangles) {
    const texWidth = 2048;
    const texHeight = Math.ceil(triangles.length / texWidth);
    const data = new Float32Array(texWidth * texHeight * 4 * 3);

    triangles.forEach((triangle, i) => {
        const offset = i * 12;
        data.set([triangle.normalA.x, triangle.normalA.y, triangle.normalA.z, 0], offset);
        data.set([triangle.normalB.x, triangle.normalB.y, triangle.normalB.z, 0], offset + 4);
        data.set([triangle.normalC.x, triangle.normalC.y, triangle.normalC.z, 0], offset + 8);
    });

    const texture = new DataTexture(data, texWidth, texHeight, RGBAFormat, FloatType);
    texture.needsUpdate = true;
    return texture;
}