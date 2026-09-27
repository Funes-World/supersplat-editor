import { Mat4, Vec3 } from 'playcanvas';

import type { Scene } from '../../scene';
import { fitFrameSize, fitCompositionFrame, projectFrameEdges } from '../adapters/overlay-projection';

const toRad = (deg: number) => (deg * Math.PI) / 180;

class InitialFrameOverlay {
    container: HTMLElement | null = null;
    scene: Scene;
    svg: SVGSVGElement | null = null;
    path: SVGPathElement | null = null;
    label: SVGTextElement | null = null;
    corners: Vec3[] = [new Vec3(), new Vec3(), new Vec3(), new Vec3()];
    viewProjection = new Mat4();
    captured = false;
    updateFn: (() => void) | undefined;
    tempR = new Vec3();
    tempU = new Vec3();

    constructor(scene: Scene, container?: HTMLElement | null, private readonly safeFrameAspect?: number) {
        this.scene = scene;
        this.container = container ?? (document.getElementById('canvas-container') as HTMLElement);

        if (!this.container) {
            console.warn('[InitialFrameOverlay] missing container; overlay disabled');
            this.updateFn = () => {};
            return;
        }

        if (!this.scene?.events || typeof this.scene.events.on !== 'function') {
            console.warn('[InitialFrameOverlay] missing scene events; overlay disabled');
            this.updateFn = () => {};
            return;
        }

        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.id = 'initial-frame-overlay';
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('viewBox', '0 0 1 1');

        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#f1a040');
        path.setAttribute('stroke-width', '3');
        path.setAttribute('stroke-dasharray', '8 6');
        path.setAttribute('vector-effect', 'non-scaling-stroke');

        const label = document.createElementNS(svgNS, 'text');
        label.id = 'initial-frame-label';
        label.textContent = 'Safe to display';
        label.setAttribute('fill', '#f1a040');
        label.setAttribute('font-size', '14');
        label.setAttribute('font-weight', '600');
        label.setAttribute('text-anchor', 'start');
        label.setAttribute('dominant-baseline', 'hanging');
        label.setAttribute('pointer-events', 'none');

        svg.appendChild(path);
        svg.appendChild(label);
        this.container.appendChild(svg);

        this.svg = svg;
        this.path = path;
        this.label = label;

        this.updateFn = this.update.bind(this);
        this.scene.events.on('prerender', this.updateFn);
        this.scene.events.on('camera.resize', this.updateFn);
        window.addEventListener('resize', this.updateFn);

        this.update();
    }

    captureInitialCorners() {
        if (this.captured) return;
        if (!this.scene?.camera) return;
        const { targetSize } = this.scene;
        if (!targetSize.width || !targetSize.height) {
            return;
        }

        const camComp = this.scene.camera.camera;
        const cameraEntity = this.scene.camera.mainCamera;
        const focal = this.scene.camera.focalPoint;
        const position = cameraEntity.getPosition();

        const right = cameraEntity.right.clone().normalize();
        const up = cameraEntity.up.clone().normalize();

        const dist = focal.clone().sub(position).length();
        if (dist <= 0) {
            return;
        }

        const aspect = targetSize.height > 0 ? targetSize.width / targetSize.height : 1;
        const fovRad = toRad(this.scene.camera.fov);
        const isHorizontalFov = camComp.horizontalFov;
        const vFov = isHorizontalFov ? 2 * Math.atan(Math.tan(fovRad / 2) / aspect) : fovRad;
        const hFov = isHorizontalFov ? fovRad : 2 * Math.atan(Math.tan(fovRad / 2) * aspect);

        const { width, height } = fitFrameSize(
            2 * dist * Math.tan(hFov / 2),
            2 * dist * Math.tan(vFov / 2),
            this.safeFrameAspect
        );
        const halfH = height * 0.5;
        const halfW = width * 0.5;

        const setCorner = (sx: number, sy: number, idx: number) => {
            this.tempR.copy(right).mulScalar(halfW * sx);
            this.tempU.copy(up).mulScalar(halfH * sy);
            this.corners[idx].copy(focal).add(this.tempR).add(this.tempU);
        };

        // order: bottom-left, bottom-right, top-right, top-left (screen space)
        setCorner(-1, -1, 0);
        setCorner(1, -1, 1);
        setCorner(1, 1, 2);
        setCorner(-1, 1, 3);

        this.captured = true;
    }

    update() {
        // Composition is a screen-space guide, not a plane attached to the
        // original camera target. It must stay still during zoom, pan and orbit.
        if (document.body.classList.contains('funes-framing')) {
            if (!this.container || !this.path || !this.svg) return;
            const { clientWidth, clientHeight } = this.container;
            if (!clientWidth || !clientHeight) return;
            const { width, height, x, y } = fitCompositionFrame(clientWidth, clientHeight, this.safeFrameAspect);
            this.svg.setAttribute('viewBox', `0 0 ${clientWidth} ${clientHeight}`);
            this.path.setAttribute('d', `M ${x},${y} h ${width} v ${height} h ${-width} Z`);
            this.path.style.display = '';
            if (this.label) {
                this.label.style.display = '';
                this.label.setAttribute('x', `${Math.max(8, x + width - this.label.getComputedTextLength() - 8)}`);
                this.label.setAttribute('y', `${y + 8}`);
            }
            return;
        }
        if (!this.captured) {
            this.captureInitialCorners();
        }

        if (!this.container || !this.path || !this.svg || !this.scene?.camera) {
            return;
        }

        const { clientWidth, clientHeight } = this.container;
        if (!clientWidth || !clientHeight || !this.captured) {
            this.path.style.display = 'none';
            if (this.label) this.label.style.display = 'none';
            return;
        }

        this.svg.setAttribute('viewBox', `0 0 ${clientWidth} ${clientHeight}`);

        const camera = this.scene.camera.camera;
        this.viewProjection.mul2(camera.projectionMatrix, camera.viewMatrix);
        const edges = projectFrameEdges(this.corners, this.viewProjection, this.scene.camera.ortho);
        if (!edges.length) {
            this.path.style.display = 'none';
            if (this.label) this.label.style.display = 'none';
            return;
        }

        this.path.setAttribute('d', edges.map(([a, b]) =>
            `M ${a.x * clientWidth},${a.y * clientHeight} L ${b.x * clientWidth},${b.y * clientHeight}`
        ).join(' '));
        this.path.style.display = '';

        if (this.label) {
            // Keep the caption inside the viewport, including at the initial
            // pose where the reference frame touches all four viewport edges.
            const anchor = edges.flat().sort((a, b) => a.y - b.y || b.x - a.x)[0];
            this.label.style.display = '';
            const width = this.label.getComputedTextLength();
            this.label.setAttribute('x', `${Math.max(8, Math.min(clientWidth - width - 8, anchor.x * clientWidth + 8))}`);
            this.label.setAttribute('y', `${Math.max(8, Math.min(clientHeight - 22, anchor.y * clientHeight + 8))}`);
        }
    }

    destroy() {
        if (this.updateFn) {
            this.scene.events.off('prerender', this.updateFn);
            this.scene.events.off('camera.resize', this.updateFn);
            window.removeEventListener('resize', this.updateFn);
        }

        if (this.svg && this.svg.parentElement) {
            this.svg.parentElement.removeChild(this.svg);
        }
    }
}

export { InitialFrameOverlay };
