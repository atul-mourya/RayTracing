import { Vector3 } from "three";

export default class RayTracingMaterial {
    constructor(color = new Vector3(1, 1, 1), emissionColor = new Vector3(0, 0, 0), emissionStrength = 0) {
        this.color = color;
        this.emissionColor = emissionColor;
        this.emissionStrength = emissionStrength;
    }
}