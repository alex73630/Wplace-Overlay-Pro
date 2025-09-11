import { matchTileUrl } from './overlay';
import { showToast } from './toast';

export function forceTileRefresh() {
    const CANVAS_CONTAINER_SELECTOR = '.canvas-container';

    const performRefresh = (container: HTMLElement) => {
        if (!container) return false;
        const tiles = container.querySelectorAll('img');
        if (tiles.length === 0) return false;

        tiles.forEach(img => {
            if (img.src && matchTileUrl(img.src)) {
                const url = new URL(img.src);
                url.searchParams.set('t', Date.now().toString());
                img.src = url.toString();
            }
        });
        showToast('Canvas updated.', 'info', 1500);
        return true;
    };

    const canvasContainer = document.querySelector(CANVAS_CONTAINER_SELECTOR) as HTMLElement;
    if (canvasContainer && performRefresh(canvasContainer)) {
        return;
    }

    const observer = new MutationObserver((mutations, obs) => {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                const container = document.querySelector(CANVAS_CONTAINER_SELECTOR) as HTMLElement;
                if (container && performRefresh(container)) {
                    clearTimeout(safetyTimeout);
                    obs.disconnect();
                    return;
                }
            }
        }
    });

    const safetyTimeout = setTimeout(() => {
        observer.disconnect();
        showToast('Error: Could not find canvas to refresh.', 'error', 3000);
    }, 10000);

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
}
