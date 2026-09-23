import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoader, pc } from './load-ts.mjs';

const { fitFrameSize, projectFrameEdges } = createLoader()('funes/adapters/overlay-projection.ts');
const perspective = new pc.Mat4().setPerspective(90, 1, 1, 100);
const v = (x, y, z) => new pc.Vec3(x, y, z);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
const bounded = edges => {
    for (const point of edges.flat()) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
        assert.ok(point.x >= -1e-6 && point.x <= 1 + 1e-6);
        assert.ok(point.y >= -1e-6 && point.y <= 1 + 1e-6);
    }
};

test('initial rectangle keeps all four original edges in viewport coordinates', () => {
    const edges = projectFrameEdges([v(-2, -2, -2), v(2, -2, -2), v(2, 2, -2), v(-2, 2, -2)], perspective);
    assert.equal(edges.length, 4);
    const expected = [[0, 1], [1, 1], [1, 0], [0, 0]];
    edges.forEach(([a, b], i) => {
        close(a.x, expected[i][0]); close(a.y, expected[i][1]);
        close(b.x, expected[(i + 1) % 4][0]); close(b.y, expected[(i + 1) % 4][1]);
    });
});

test('an edge crossing the camera clips before perspective division without reconnecting lost corners', () => {
    const edges = projectFrameEdges([v(-0.5, -0.5, -2), v(0.5, -0.5, 1), v(0.5, 0.5, 1), v(-0.5, 0.5, -2)], perspective);
    assert.equal(edges.length, 3, 'the fully behind-camera edge must disappear');
    bounded(edges);
    close(edges[0][1].x, 5 / 12); close(edges[0][1].y, 0.75);
    close(edges[1][0].x, 5 / 12); close(edges[1][0].y, 0.25);
    assert.notDeepEqual(edges[0][1], edges[1][0], 'clipped edges stay separate, with no artificial closing edge');
});

test('partially offscreen reference keeps the visible portions of its actual edges', () => {
    const edges = projectFrameEdges([v(-4, -1, -2), v(1, -1, -2), v(1, 1, -2), v(-4, 1, -2)], perspective);
    assert.equal(edges.length, 3);
    bounded(edges);
    close(edges[0][0].x, 0); close(edges[2][1].x, 0);
    assert.ok(edges.every(([a, b]) => a.x !== b.x || a.x > 0), 'do not invent a border along the clipping plane');
});

test('a reference entirely behind the camera or beyond the far plane is hidden', () => {
    for (const z of [2, -101]) {
        assert.equal(projectFrameEdges([v(-1, -1, z), v(1, -1, z), v(1, 1, z), v(-1, 1, z)], perspective).length, 0);
    }
});

test('orthographic axis views keep the guide even when its edges exceed the model depth range', () => {
    const corners = [v(-2, -1, 0), v(2, -1, 0), v(2, 1, 0), v(-2, 1, 0)];
    const projection = new pc.Mat4().setOrtho(-3, 3, -2, 2, 4.5, 5.5);
    for (const [axis, position, angles] of [
        ['X', v(5, 0, 0), [0, 90, 0]], ['-X', v(-5, 0, 0), [0, -90, 0]],
        ['Y', v(0, 5, 0), [-90, 0, 0]], ['-Y', v(0, -5, 0), [90, 0, 0]],
        ['Z', v(0, 0, 5), [0, 0, 0]], ['-Z', v(0, 0, -5), [0, 180, 0]]
    ]) {
        const view = new pc.Mat4().setTRS(position, new pc.Quat().setFromEulerAngles(...angles), pc.Vec3.ONE).invert();
        const edges = projectFrameEdges(corners, new pc.Mat4().mul2(projection, view), true);
        assert.equal(edges.length, 4, `${axis}: all original guide edges must survive model depth clipping`);
        bounded(edges);
        const xs = edges.flat().map(p => p.x), ys = edges.flat().map(p => p.y);
        const width = Math.max(...xs) - Math.min(...xs);
        const height = Math.max(...ys) - Math.min(...ys);
        // Normalized extents; in a 600 x 400 viewport the front view is 400 x 200.
        if (axis.endsWith('X')) { close(width, 0); close(height, 0.5); }
        if (axis.endsWith('Y')) { close(width, 2 / 3); close(height, 0); }
        if (axis.endsWith('Z')) { close(width, 2 / 3); close(height, 0.5); }
    }
});

test('orthographic guides still clip to the viewport without creating new edges', () => {
    const projection = new pc.Mat4().setOrtho(-1, 1, -1, 1, 4.5, 5.5);
    const edges = projectFrameEdges([v(-2, -0.5, 0), v(0.5, -0.5, 0), v(0.5, 0.5, 0), v(-2, 0.5, 0)], projection, true);
    assert.equal(edges.length, 3);
    bounded(edges);
    close(edges[0][0].x, 0); close(edges[2][1].x, 0);
    assert.ok(edges.every(([a, b]) => a.x !== b.x || a.x > 0));
});


test('safe frame keeps the full host ratio inside landscape, square and portrait editor viewports', () => {
    const aspect = 1248 / 596;
    for (const [width, height] of [[952, 596], [1200, 500], [600, 600], [400, 700]]) {
        const fitted = fitFrameSize(width, height, aspect);
        close(fitted.width / fitted.height, aspect);
        assert.ok(fitted.width <= width && fitted.height <= height);
        assert.ok(fitted.width === width || fitted.height === height);
    }
});

test('standalone editor keeps its viewport frame when no valid host ratio is supplied', () => {
    for (const aspect of [undefined, 0, -2, NaN, Infinity]) {
        const fitted = fitFrameSize(952, 596, aspect);
        close(fitted.width, 952); close(fitted.height, 596);
    }
});
