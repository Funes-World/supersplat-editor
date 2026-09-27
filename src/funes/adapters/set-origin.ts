import { Mat4, Quat, Vec3 } from 'playcanvas';
import type { Splat } from '../../splat';

/** Rebase point transforms into a zero-translation entity without moving geometry.
 * Native export consumes these palettes, so PLY/SOG/LOD all retain the new origin.
 */
export class SetModelOriginOp {
    name = 'setModelOrigin';
    private indices: Uint32Array;
    private position: Vec3;
    private origin: Vec3;
    private frame: Quat;
    private allocated = 0;
    constructor(private splat: Splat) {}

    async do() {
        const splat = this.splat;
        const { instances, transformPalette: palette, entity } = splat;
        const position = entity.getLocalPosition().clone();
        const scale = entity.getLocalScale();
        if ([scale.x, scale.y, scale.z].some(n => !Number.isFinite(n) || n === 0)) {
            throw new Error('Cannot set origin while model scale is zero or invalid.');
        }
        this.position = position;
        this.origin = splat.localFrameOrigin.clone();
        this.frame = splat.localFrame.clone();
        this.indices = new Uint32Array(instances.count);
        const offset = entity.getLocalRotation().clone().invert().transformVector(position);
        offset.x /= scale.x; offset.y /= scale.y; offset.z /= scale.z;
        const translation = new Mat4().setTranslate(offset.x, offset.y, offset.z);
        for (let i = 0; i < instances.count; i++) this.indices[i] = instances.transformIndex(i);
        const mapping = new Map<number, number>();
        const matrix = new Mat4();
        try {
            for (let i = 0; i < instances.count; i++) {
                const index = instances.transformIndex(i);
                if (!mapping.has(index)) {
                    const next = palette.alloc();
                    this.allocated++;
                    palette.getTransform(index, matrix);
                    palette.setTransform(next, new Mat4().mul2(translation, matrix));
                    mapping.set(index, next);
                }
            }
            for (let i = 0; i < instances.count; i++) instances.setTransformIndex(i, mapping.get(this.indices[i]));
            splat.move(Vec3.ZERO);
            splat.setLocalFrame(Vec3.ZERO, Quat.IDENTITY);
            await splat.updatePositions();
        }
        catch (error) { await this.undo(); throw error; }
    }

    async undo() {
        const splat = this.splat;
        for (let i = 0; i < this.indices.length; i++) splat.instances.setTransformIndex(i, this.indices[i]);
        splat.transformPalette.free(this.allocated);
        this.allocated = 0;
        splat.move(this.position);
        splat.setLocalFrame(this.origin, this.frame);
        await splat.updatePositions();
    }

    destroy() { this.indices = null; this.splat = null; }
}
