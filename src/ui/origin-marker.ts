import { Vec3 } from 'playcanvas';

import { Scene } from '../scene';

class OriginMarker {
    dom: HTMLDivElement;
    scene: Scene;
    container: HTMLElement;
    origin = new Vec3(0, 0, 0);
    screen = new Vec3();
    updateFn: () => void;

    constructor(scene: Scene, container: HTMLElement) {
        this.scene = scene;
        this.container = container;

        this.dom = document.createElement('div');
        this.dom.id = 'origin-marker';
        this.dom.setAttribute('aria-hidden', 'true');
        this.container.appendChild(this.dom);

        this.updateFn = this.update.bind(this);

        this.scene.events.on('prerender', this.updateFn);
        this.scene.events.on('camera.resize', this.updateFn);
        window.addEventListener('resize', this.updateFn);

        this.update();
    }

    update() {
        const { clientWidth, clientHeight } = this.container;
        if (!clientWidth || !clientHeight) {
            this.dom.style.display = 'none';
            return;
        }

        this.scene.camera.worldToScreen(this.origin, this.screen);

        const x = this.screen.x * clientWidth;
        const y = this.screen.y * clientHeight;

        const finite = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(this.screen.z);

        const visible = finite &&
            this.screen.z >= -1 && this.screen.z <= 1 &&
            x >= 0 && x <= clientWidth &&
            y >= 0 && y <= clientHeight;

        if (!visible) {
            this.dom.style.display = 'none';
            return;
        }

        this.dom.style.display = '';
        this.dom.style.left = `${x}px`;
        this.dom.style.top = `${y}px`;
    }

    destroy() {
        this.scene.events.off('prerender', this.updateFn);
        this.scene.events.off('camera.resize', this.updateFn);
        window.removeEventListener('resize', this.updateFn);
        if (this.dom.parentElement) {
            this.dom.parentElement.removeChild(this.dom);
        }
    }
}

export { OriginMarker };
