import { Mat4, Vec3, Vec4 } from 'playcanvas';

type ScreenPoint = { x: number; y: number };
type ScreenEdge = [ScreenPoint, ScreenPoint];

// The host's intended display ratio can differ from the editor viewport after
// it reserves a column for save settings. Fit it inside that viewport without
// stretching it or changing the camera/model pose.
const fitFrameSize = (width: number, height: number, aspect?: number) => {
    if (!Number.isFinite(aspect) || aspect <= 0) return { width, height };
    return width / height > aspect
        ? { width: height * aspect, height }
        : { width, height: width / aspect };
};

// Editor v3's camera.worldToScreen uses this same projection * view matrix
// and -w..w clip volume, even with a WebGPU render target. Clip before the
// perspective divide so an edge crossing the camera cannot flip or reconnect
// unrelated corners. Every returned segment belongs to an original edge.
// Orthographic views show a reference guide, independent of the model's fitted
// near/far planes. Depth does not affect its projection; clipping it to those
// planes would erase the overlapping long edges in an edge-on axis view.
const projectFrameEdges = (corners: readonly Vec3[], viewProjection: Mat4, orthographic = false): ScreenEdge[] => {
    const projected = corners.map(corner =>
        viewProjection.transformVec4(new Vec4(corner.x, corner.y, corner.z, 1)));
    const planes = (v: Vec4) => {
        const result = [v.w + v.x, v.w - v.x, v.w + v.y, v.w - v.y, v.w - 1e-6];
        if (!orthographic) result.push(v.w + v.z, v.w - v.z);
        return result;
    };
    const edges: ScreenEdge[] = [];
    for (let i = 0; i < projected.length; i++) {
        const a = projected[i];
        const b = projected[(i + 1) % projected.length];
        const from = planes(a);
        const to = planes(b);
        if (![...from, ...to].every(Number.isFinite)) continue;
        let start = 0;
        let end = 1;
        for (let j = 0; j < from.length; j++) {
            if (from[j] < 0 && to[j] < 0) { end = -1; break; }
            if (from[j] < 0) start = Math.max(start, from[j] / (from[j] - to[j]));
            if (to[j] < 0) end = Math.min(end, from[j] / (from[j] - to[j]));
        }
        if (start >= end) continue;
        const point = (t: number): ScreenPoint => {
            const w = a.w + (b.w - a.w) * t;
            return {
                x: (a.x + (b.x - a.x) * t) / w * 0.5 + 0.5,
                y: 0.5 - (a.y + (b.y - a.y) * t) / w * 0.5
            };
        };
        edges.push([point(start), point(end)]);
    }
    return edges;
};

export { fitFrameSize, projectFrameEdges };
