import { Events } from "./events";

type ImportTarget = {
  filename: string;
  url: string;
};

const PARAM_KEYS = ["load", "model", "splat", "splatUrl"];

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    console.warn("[supersplat] Failed to decode param value", value, err);
    return value;
  }
};

const guessFilename = (value: string) => {
  try {
    const clean = value.split(/[?#]/)[0];
    const parts = clean.split(/[/\\]/);
    const last = parts.pop();
    return last && last.length ? last : "model";
  } catch (e) {
    return "model";
  }
};

const collectImportTargets = (url: URL): ImportTarget[] => {
  const targets: ImportTarget[] = [];

  url.searchParams.forEach((value, key) => {
    if (!PARAM_KEYS.includes(key)) {
      return;
    }
    const decoded = safeDecode(value).trim();
    if (!decoded) return;

    targets.push({
      filename: guessFilename(decoded),
      url: decoded,
    });
  });

  return targets;
};

const loadFromQueryParams = async (url: URL, events: Events) => {
  const targets = collectImportTargets(url);
  for (const target of targets) {
    await events.invoke("import", [target]);
  }
};

export { loadFromQueryParams };
