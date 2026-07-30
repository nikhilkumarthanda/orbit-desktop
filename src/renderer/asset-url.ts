export const assetUrl = (path: string) => new URL(`./${path.replace(/^\.?\/*/, "")}`, document.baseURI).href;
