import { Vec3 } from 'playcanvas';

import { Scene } from '../scene';

const toRad = (deg: number) => (deg * Math.PI) / 180;

class InitialFrameOverlay {
    container: HTMLElement | null = null;
    scene: Scene;
    svg: SVGSVGElement | null = null;
    polyline: SVGPolylineElement | null = null;
    label: SVGTextElement | null = null;
    corners: Vec3[] = [new Vec3(), new Vec3(), new Vec3(), new Vec3()];
    screenCorners: Vec3[] = [new Vec3(), new Vec3(), new Vec3(), new Vec3()];
    captured = false;
    updateFn: (() => void) | undefined;
    tempR = new Vec3();
    tempU = new Vec3();
    logCount = 0;
    logLimit = 20;

    constructor(scene: Scene, container?: HTMLElement | null) {
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

        this.debug('init container', {
            hasContainer: !!this.container,
            hasEvents: !!this.scene?.events
        });

        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.id = 'initial-frame-overlay';
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('viewBox', '0 0 1 1');

        const polyline = document.createElementNS(svgNS, 'polyline');
        polyline.setAttribute('fill', 'none');
        polyline.setAttribute('stroke', '#f1a040');
        polyline.setAttribute('stroke-width', '3');
        polyline.setAttribute('stroke-dasharray', '8 6');
        polyline.setAttribute('vector-effect', 'non-scaling-stroke');

        const label = document.createElementNS(svgNS, 'text');
        label.id = 'initial-frame-label';
        label.textContent = 'Safe to display';
        label.setAttribute('fill', '#f1a040');
        label.setAttribute('font-size', '14');
        label.setAttribute('font-weight', '600');
        label.setAttribute('text-anchor', 'start');
        label.setAttribute('dominant-baseline', 'hanging');
        label.setAttribute('pointer-events', 'none');

        svg.appendChild(polyline);
        svg.appendChild(label);
        this.container.appendChild(svg);

        this.svg = svg;
        this.polyline = polyline;
        this.label = label;

        this.updateFn = this.update.bind(this);
        this.scene.events.on('prerender', this.updateFn);
        this.scene.events.on('camera.resize', this.updateFn);
        window.addEventListener('resize', this.updateFn);

        this.update();
    }

    debug(msg: string, data?: Record<string, unknown>) {
        if (this.logCount >= this.logLimit) return;
        this.logCount++;
        if (data) {
            console.log(`[InitialFrameOverlay] ${msg}`, data);
        } else {
            console.log(`[InitialFrameOverlay] ${msg}`);
        }
    }

    captureInitialCorners() {
        if (this.captured) return;
        if (!this.scene?.camera) return;
        const { targetSize } = this.scene;
        if (!targetSize.width || !targetSize.height) {
            this.debug('capture skipped: targetSize missing', { targetSize });
            return;
        }

        const camComp = this.scene.camera.entity.camera;
        const cameraEntity = this.scene.camera.entity;
        const focal = this.scene.camera.focalPoint;
        const position = cameraEntity.getPosition();

        const forward = cameraEntity.forward.clone().normalize();
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

        const height = 2 * dist * Math.tan(vFov / 2);
        const width = 2 * dist * Math.tan(hFov / 2);
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
        this.debug('captured corners', {
            dist,
            width,
            height,
            aspect,
            fov: this.scene.camera.fov,
            hFov,
            vFov,
            focal: { ...focal },
            position: { ...position }
        });
    }

    update() {
        if (!this.captured) {
            this.captureInitialCorners();
        }

        if (!this.container || !this.polyline || !this.svg || !this.scene?.camera) {
            return;
        }

        const { clientWidth, clientHeight } = this.container;
        if (!clientWidth || !clientHeight || !this.captured) {
            this.polyline.style.display = 'none';
            if (this.label) this.label.style.display = 'none';
            this.debug('update skipped: size/captured', { clientWidth, clientHeight, captured: this.captured });
            return;
        }

        this.svg.setAttribute('viewBox', `0 0 ${clientWidth} ${clientHeight}`);

        let visiblePoints = 0;
        const projected: { x: number; y: number; z: number }[] = [];

        for (let i = 0; i < 4; i++) {
            const corner = this.corners[i];
            const screen = this.screenCorners[i];
            this.scene.camera.worldToScreen(corner, screen);

            const x = screen.x * clientWidth;
            const y = screen.y * clientHeight;

            if (Number.isFinite(x) && Number.isFinite(y) && screen.z >= -1 && screen.z <= 1) {
                projected.push({ x, y, z: screen.z });
                visiblePoints++;
            }
        }

        if (visiblePoints < 2) {
            this.polyline.style.display = 'none';
            if (this.label) this.label.style.display = 'none';
            this.debug('update hide: insufficient visible points', { visiblePoints, projected });
            return;
        }

        // fixed order: bl, br, tr, tl (as captured)
        const ordered = projected.map(({ x, y }) => `${x},${y}`);
        const first = ordered[0];
        this.polyline.setAttribute('points', `${ordered.join(' ')} ${first}`);
        this.polyline.style.display = '';

        // position label at top-right corner (corner index 2)
        if (this.label) {
            const anchor = projected[2] ?? projected[0];
            const lx = anchor?.x ?? 0;
            const ly = anchor?.y ?? 0;
            const offset = 8;
            this.label.setAttribute('x', `${lx + offset}`);
            this.label.setAttribute('y', `${ly + offset}`);
            this.label.style.display = '';
        }
        this.debug('update draw', { points: ordered, projected });
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
