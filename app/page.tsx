"use client";

/* eslint-disable react-hooks/refs -- SVG pointer callbacks are only invoked by pointer events. */

import {
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const SCALE = 64;
const PLAN_WIDTH_M = 18;
const PLAN_HEIGHT_M = 8;
const PLAN_WIDTH = PLAN_WIDTH_M * SCALE;
const PLAN_HEIGHT = PLAN_HEIGHT_M * SCALE;
const MIN_RECT_SIZE = 0.2;
const HISTORY_LIMIT = 60;
const STORAGE_KEY = "magaza-planlayici-v1";

type Tool = "select" | "pan" | "wall" | "measure";
type RectKind = "room" | "object";
type LineKind = "wall" | "measure";
type Point = { x: number; y: number };
type SnapGuides = { vertical: number[]; horizontal: number[] };

type RectElement = {
  id: string;
  kind: RectKind;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  locked?: boolean;
  groupId?: string;
};

type LineElement = {
  id: string;
  kind: LineKind;
  name: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness?: number;
  locked?: boolean;
  groupId?: string;
};

type PlanElement = RectElement | LineElement;
type Camera = { x: number; y: number; w: number; h: number };
type ResizeCorner = "nw" | "ne" | "se" | "sw";

type Interaction =
  | {
      type: "pan";
      startClient: Point;
      startCamera: Camera;
    }
  | {
      type: "move";
      id: string;
      start: Point;
      before: PlanElement[];
      original: PlanElement;
    }
  | {
      type: "move-selection";
      ids: string[];
      start: Point;
      before: PlanElement[];
    }
  | {
      type: "resize";
      id: string;
      corner: ResizeCorner;
      before: PlanElement[];
      original: RectElement;
    }
  | {
      type: "line-end";
      id: string;
      endpoint: "start" | "end";
      before: PlanElement[];
      original: LineElement;
    };

type DraftLine = {
  kind: LineKind;
  start: Point;
  end: Point;
};

type ObjectPreset = {
  name: string;
  w: number;
  h: number;
  color: string;
  note: string;
};

const OBJECT_PRESETS: ObjectPreset[] = [
  {
    name: "Oval camlı raf",
    w: 0.9,
    h: 1.08,
    color: "#0f766e",
    note: "90 × 108 cm",
  },
  {
    name: "3 katlı raf",
    w: 1,
    h: 0.7,
    color: "#2563eb",
    note: "100 × 70 cm",
  },
  {
    name: "Satış tezgâhı",
    w: 1.5,
    h: 0.65,
    color: "#7c3aed",
    note: "150 × 65 cm",
  },
  {
    name: "Masa",
    w: 0.8,
    h: 0.8,
    color: "#b45309",
    note: "80 × 80 cm",
  },
  {
    name: "Buzdolabı",
    w: 1.2,
    h: 0.7,
    color: "#0369a1",
    note: "120 × 70 cm",
  },
  {
    name: "Kapı",
    w: 0.9,
    h: 0.14,
    color: "#9a3412",
    note: "90 cm",
  },
  {
    name: "Kolon",
    w: 0.4,
    h: 0.4,
    color: "#475569",
    note: "40 × 40 cm",
  },
  {
    name: "Yeni eşya",
    w: 1,
    h: 0.6,
    color: "#be123c",
    note: "Özel ölçü",
  },
];

const INITIAL_ELEMENTS: PlanElement[] = [
  {
    id: "room-sales",
    kind: "room",
    name: "Birleşik satış alanı",
    x: 0.8,
    y: 2,
    w: 12.32,
    h: 3.41,
    color: "#0f766e",
  },
  {
    id: "room-storage",
    kind: "room",
    name: "Depo",
    x: 13.12,
    y: 2,
    w: 3.15,
    h: 3.41,
    color: "#64748b",
  },
  {
    id: "room-wc",
    kind: "room",
    name: "WC",
    x: 14.12,
    y: 2.18,
    w: 2,
    h: 1.2,
    color: "#475569",
  },
  {
    id: "rack-oval",
    kind: "object",
    name: "Oval camlı raf — 11 modül",
    x: 1.05,
    y: 2.16,
    w: 9.9,
    h: 1.08,
    color: "#0f766e",
  },
  {
    id: "rack-three",
    kind: "object",
    name: "3 katlı raf — 10 modül",
    x: 1.05,
    y: 4.55,
    w: 10,
    h: 0.7,
    color: "#2563eb",
  },
  {
    id: "counter-kitchen",
    kind: "object",
    name: "Mutfak tezgâhı",
    x: 13.28,
    y: 4.55,
    w: 2.82,
    h: 0.7,
    color: "#b45309",
  },
  {
    id: "measure-aisle",
    kind: "measure",
    name: "Net müşteri koridoru",
    x1: 4.4,
    y1: 3.24,
    x2: 4.4,
    y2: 4.55,
  },
];

const TYPE_LABELS: Record<PlanElement["kind"], string> = {
  room: "Oda / alan",
  object: "Eşya",
  wall: "Duvar",
  measure: "Ölçü",
};

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function cloneScene(scene: PlanElement[]) {
  return scene.map((element) => ({ ...element })) as PlanElement[];
}

function isRect(element: PlanElement): element is RectElement {
  return element.kind === "room" || element.kind === "object";
}

function isLine(element: PlanElement): element is LineElement {
  return element.kind === "wall" || element.kind === "measure";
}

function lineLength(element: LineElement) {
  return Math.hypot(element.x2 - element.x1, element.y2 - element.y1);
}

function formatMetric(value: number, digits = 2) {
  return value.toLocaleString("tr-TR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function roundMetric(value: number) {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function scenePoints(element: PlanElement): Point[] {
  if (isRect(element)) {
    const { x, y, w, h } = element;
    return [
      { x, y },
      { x: x + w / 2, y },
      { x: x + w, y },
      { x: x + w, y: y + h / 2 },
      { x: x + w, y: y + h },
      { x: x + w / 2, y: y + h },
      { x, y: y + h },
      { x, y: y + h / 2 },
      { x: x + w / 2, y: y + h / 2 },
    ];
  }
  return [
    { x: element.x1, y: element.y1 },
    { x: element.x2, y: element.y2 },
    { x: (element.x1 + element.x2) / 2, y: (element.y1 + element.y2) / 2 },
  ];
}

function elementBounds(element: PlanElement) {
  if (isRect(element)) {
    return { left: element.x, top: element.y, right: element.x + element.w, bottom: element.y + element.h };
  }
  return {
    left: Math.min(element.x1, element.x2),
    top: Math.min(element.y1, element.y2),
    right: Math.max(element.x1, element.x2),
    bottom: Math.max(element.y1, element.y2),
  };
}

function validateImportedScene(value: unknown): PlanElement[] | null {
  const candidate =
    Array.isArray(value)
      ? value
      : value && typeof value === "object" && "elements" in value
        ? (value as { elements: unknown }).elements
        : null;

  if (!Array.isArray(candidate)) return null;
  const allowedKinds = new Set(["room", "object", "wall", "measure"]);
  const valid = candidate.every((item) => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.name !== "string" ||
      typeof record.kind !== "string" ||
      !allowedKinds.has(record.kind)
    ) {
      return false;
    }
    if (record.kind === "room" || record.kind === "object") {
      return ["x", "y", "w", "h"].every(
        (key) => typeof record[key] === "number" && Number.isFinite(record[key]),
      );
    }
    return ["x1", "y1", "x2", "y2"].every(
      (key) => typeof record[key] === "number" && Number.isFinite(record[key]),
    );
  });
  return valid ? (candidate as PlanElement[]) : null;
}

export default function Home() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const elementsRef = useRef<PlanElement[]>(cloneScene(INITIAL_ELEMENTS));
  const interactionRef = useRef<Interaction | null>(null);
  const propertyStartRef = useRef<PlanElement[] | null>(null);
  const copiedElementsRef = useRef<PlanElement[]>([]);
  const spacePressedRef = useRef(false);

  const [elements, setElements] = useState<PlanElement[]>(() =>
    cloneScene(INITIAL_ELEMENTS),
  );
  const [selectedIds, setSelectedIds] = useState<string[]>(["rack-oval"]);
  const [tool, setTool] = useState<Tool>("select");
  const [draft, setDraft] = useState<DraftLine | null>(null);
  const [snapPoint, setSnapPoint] = useState<Point | null>(null);
  const [snapGuides, setSnapGuides] = useState<SnapGuides>({
    vertical: [],
    horizontal: [],
  });
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [gridSnapEnabled, setGridSnapEnabled] = useState(false);
  const [gridVisible, setGridVisible] = useState(true);
  const [gridStep, setGridStep] = useState(0.25);
  const [camera, setCamera] = useState<Camera>({
    x: 0,
    y: 0,
    w: PLAN_WIDTH,
    h: PLAN_HEIGHT,
  });
  const [past, setPast] = useState<PlanElement[][]>([]);
  const [future, setFuture] = useState<PlanElement[][]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [saveLabel, setSaveLabel] = useState("Hazırlanıyor…");
  const [notice, setNotice] = useState<string | null>(null);
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const selection = useMemo(
    () => elements.filter((element) => selectedIds.includes(element.id)),
    [elements, selectedIds],
  );
  const selected = useMemo(
    () => elements.find((element) => element.id === selectedId) ?? null,
    [elements, selectedId],
  );
  const selectionLocked = selection.length > 0 && selection.every((item) => item.locked);
  const selectionGrouped = selection.some((item) => item.groupId);

  const roomArea = useMemo(
    () =>
      elements
        .filter((element): element is RectElement => element.kind === "room")
        .reduce((total, room) => total + room.w * room.h, 0),
    [elements],
  );

  const counts = useMemo(
    () => ({
      rooms: elements.filter((element) => element.kind === "room").length,
      objects: elements.filter((element) => element.kind === "object").length,
      walls: elements.filter((element) => element.kind === "wall").length,
      measures: elements.filter((element) => element.kind === "measure").length,
    }),
    [elements],
  );

  const setSceneDirect = useCallback((next: PlanElement[]) => {
    elementsRef.current = next;
    setElements(next);
  }, []);

  const recordPast = useCallback((before: PlanElement[]) => {
    setPast((items) => [
      ...items.slice(-(HISTORY_LIMIT - 1)),
      cloneScene(before),
    ]);
    setFuture([]);
  }, []);

  const commitScene = useCallback(
    (next: PlanElement[]) => {
      recordPast(elementsRef.current);
      setSceneDirect(next);
    },
    [recordPast, setSceneDirect],
  );

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 2200);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved) as {
            elements?: unknown;
            snapEnabled?: boolean;
            gridSnapEnabled?: boolean;
            gridVisible?: boolean;
            gridStep?: number;
          };
          const savedElements = validateImportedScene(parsed);
          if (savedElements) setSceneDirect(cloneScene(savedElements));
          if (typeof parsed.snapEnabled === "boolean") {
            setSnapEnabled(parsed.snapEnabled);
          }
          if (typeof parsed.gridSnapEnabled === "boolean") {
            setGridSnapEnabled(parsed.gridSnapEnabled);
          }
          if (typeof parsed.gridVisible === "boolean") {
            setGridVisible(parsed.gridVisible);
          }
          if ([0.1, 0.25, 0.5, 1].includes(parsed.gridStep ?? -1)) {
            setGridStep(parsed.gridStep as number);
          }
        }
      } catch {
        // Bozuk yerel kayıt başlangıç örneğini engellemez.
      }
      setHydrated(true);
      setSaveLabel("Cihaza kaydedildi");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [setSceneDirect]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            elements,
            snapEnabled,
            gridSnapEnabled,
            gridVisible,
            gridStep,
          }),
        );
        setSaveLabel("Cihaza kaydedildi");
      } catch {
        setSaveLabel("Kayıt yapılamadı");
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [elements, gridSnapEnabled, gridStep, gridVisible, hydrated, snapEnabled]);

  const undo = useCallback(() => {
    if (!past.length) return;
    const previous = past[past.length - 1];
    const current = cloneScene(elementsRef.current);
    setPast((items) => items.slice(0, -1));
    setFuture((items) => [current, ...items].slice(0, HISTORY_LIMIT));
    setSceneDirect(cloneScene(previous));
    setSelectedIds([]);
  }, [past, setSceneDirect]);

  const redo = useCallback(() => {
    if (!future.length) return;
    const next = future[0];
    const current = cloneScene(elementsRef.current);
    setFuture((items) => items.slice(1));
    setPast((items) => [
      ...items.slice(-(HISTORY_LIMIT - 1)),
      current,
    ]);
    setSceneDirect(cloneScene(next));
    setSelectedIds([]);
  }, [future, setSceneDirect]);

  const cameraCenterMeters = useCallback(
    () => ({
      x: (camera.x + camera.w / 2) / SCALE,
      y: (camera.y + camera.h / 2) / SCALE,
    }),
    [camera],
  );

  const addRect = useCallback(
    (kind: RectKind, preset?: ObjectPreset) => {
      const center = cameraCenterMeters();
      const w = preset?.w ?? 3;
      const h = preset?.h ?? 2.4;
      const next: RectElement = {
        id: makeId(kind),
        kind,
        name: preset?.name ?? "Yeni oda",
        x: roundMetric(clamp(center.x - w / 2, 0, PLAN_WIDTH_M - w)),
        y: roundMetric(clamp(center.y - h / 2, 0, PLAN_HEIGHT_M - h)),
        w,
        h,
        color: preset?.color ?? "#0f766e",
      };
      commitScene([...elementsRef.current, next]);
      setSelectedIds([next.id]);
      setTool("select");
      showNotice(`${next.name} eklendi`);
    },
    [cameraCenterMeters, commitScene, showNotice],
  );

  const deleteSelected = useCallback(() => {
    if (!selectedIds.length) return;
    const deletable = new Set(
      elementsRef.current
        .filter((item) => selectedIds.includes(item.id) && !item.locked)
        .map((item) => item.id),
    );
    if (!deletable.size) {
      showNotice("Kilitli öğeler silinemez; önce kilidi aç");
      return;
    }
    commitScene(elementsRef.current.filter((item) => !deletable.has(item.id)));
    setSelectedIds((ids) => ids.filter((id) => !deletable.has(id)));
    showNotice(`${deletable.size} öğe silindi`);
  }, [commitScene, selectedIds, showNotice]);

  const duplicateSelected = useCallback(() => {
    if (!selection.length) return;
    const groupMap = new Map<string, string>();
    const duplicates = selection.map((element) => {
      const id = makeId(element.kind);
      const groupId = element.groupId
        ? groupMap.get(element.groupId) ?? makeId("group")
        : undefined;
      if (element.groupId && groupId) groupMap.set(element.groupId, groupId);
      return isRect(element)
        ? {
            ...element,
            id,
            groupId,
            locked: false,
            name: `${element.name} kopyası`,
            x: roundMetric(element.x + 0.25),
            y: roundMetric(element.y + 0.25),
          }
        : {
            ...element,
            id,
            groupId,
            locked: false,
            name: `${element.name} kopyası`,
            x1: roundMetric(element.x1 + 0.25),
            y1: roundMetric(element.y1 + 0.25),
            x2: roundMetric(element.x2 + 0.25),
            y2: roundMetric(element.y2 + 0.25),
          };
    }) as PlanElement[];
    commitScene([...elementsRef.current, ...duplicates]);
    setSelectedIds(duplicates.map((item) => item.id));
    showNotice(`${duplicates.length} öğenin kopyası oluşturuldu`);
  }, [commitScene, selection, showNotice]);

  const copySelected = useCallback(() => {
    if (!selection.length) return;
    copiedElementsRef.current = cloneScene(selection);
    showNotice(`${selection.length} öğe kopyalandı`);
  }, [selection, showNotice]);

  const pasteCopied = useCallback(() => {
    if (!copiedElementsRef.current.length) return;
    const groupMap = new Map<string, string>();
    const pasted = copiedElementsRef.current.map((element) => {
      const id = makeId(element.kind);
      const groupId = element.groupId
        ? groupMap.get(element.groupId) ?? makeId("group")
        : undefined;
      if (element.groupId && groupId) groupMap.set(element.groupId, groupId);
      return isRect(element)
        ? {
            ...element,
            id,
            groupId,
            locked: false,
            name: `${element.name} kopyası`,
            x: roundMetric(clamp(element.x + 0.15, 0, PLAN_WIDTH_M - element.w)),
            y: roundMetric(clamp(element.y + 0.15, 0, PLAN_HEIGHT_M - element.h)),
          }
        : {
            ...element,
            id,
            groupId,
            locked: false,
            name: `${element.name} kopyası`,
            x1: roundMetric(element.x1 + 0.15),
            y1: roundMetric(element.y1 + 0.15),
            x2: roundMetric(element.x2 + 0.15),
            y2: roundMetric(element.y2 + 0.15),
          };
    }) as PlanElement[];
    commitScene([...elementsRef.current, ...pasted]);
    setSelectedIds(pasted.map((item) => item.id));
    copiedElementsRef.current = cloneScene(pasted);
    showNotice("Kopya plana yapıştırıldı");
  }, [commitScene, showNotice]);

  const nudgeSelected = useCallback(
    (dx: number, dy: number) => {
      if (!selection.length) return;
      const movable = new Set(selection.filter((item) => !item.locked).map((item) => item.id));
      if (!movable.size) return;
      const next = elementsRef.current.map((element) => {
        if (!movable.has(element.id)) return element;
        if (isRect(element)) {
          return {
            ...element,
            x: roundMetric(clamp(element.x + dx, 0, PLAN_WIDTH_M - element.w)),
            y: roundMetric(clamp(element.y + dy, 0, PLAN_HEIGHT_M - element.h)),
          };
        }
        return {
          ...element,
          x1: roundMetric(element.x1 + dx),
          y1: roundMetric(element.y1 + dy),
          x2: roundMetric(element.x2 + dx),
          y2: roundMetric(element.y2 + dy),
        };
      });
      commitScene(next);
    },
    [commitScene, selection],
  );

  const groupSelection = useCallback(() => {
    if (selection.length < 2) return;
    const groupId = makeId("group");
    const ids = new Set(selectedIds);
    commitScene(
      elementsRef.current.map((element) =>
        ids.has(element.id) ? { ...element, groupId } : element,
      ),
    );
    showNotice(`${selection.length} öğe gruplandı`);
  }, [commitScene, selectedIds, selection.length, showNotice]);

  const ungroupSelection = useCallback(() => {
    const groupIds = new Set(selection.map((item) => item.groupId).filter(Boolean));
    if (!groupIds.size) return;
    const affected = elementsRef.current.filter(
      (item) => item.groupId && groupIds.has(item.groupId),
    );
    commitScene(
      elementsRef.current.map((element) =>
        element.groupId && groupIds.has(element.groupId)
          ? { ...element, groupId: undefined }
          : element,
      ),
    );
    setSelectedIds(affected.map((item) => item.id));
    showNotice("Grup çözüldü");
  }, [commitScene, selection, showNotice]);

  const toggleLockSelection = useCallback(() => {
    if (!selection.length) return;
    const ids = new Set(selectedIds);
    const nextLocked = !selectionLocked;
    commitScene(
      elementsRef.current.map((element) =>
        ids.has(element.id) ? { ...element, locked: nextLocked } : element,
      ),
    );
    showNotice(nextLocked ? "Seçim kilitlendi" : "Seçimin kilidi açıldı");
  }, [commitScene, selectedIds, selection.length, selectionLocked, showNotice]);

  const rotateSelected = useCallback(() => {
    if (!selected || !isRect(selected) || selected.locked) return;
    const centerX = selected.x + selected.w / 2;
    const centerY = selected.y + selected.h / 2;
    const next = elementsRef.current.map((element) =>
      element.id === selected.id
        ? {
            ...selected,
            x: roundMetric(centerX - selected.h / 2),
            y: roundMetric(centerY - selected.w / 2),
            w: selected.h,
            h: selected.w,
          }
        : element,
    );
    commitScene(next);
  }, [commitScene, selected]);

  const moveLayer = useCallback(
    (direction: "front" | "back") => {
      if (!selectedId) return;
      const current = elementsRef.current;
      const index = current.findIndex((element) => element.id === selectedId);
      if (index < 0) return;
      const target = current[index];
      if (target.locked) return;
      const rest = current.filter((element) => element.id !== selectedId);
      commitScene(
        direction === "front" ? [...rest, target] : [target, ...rest],
      );
    },
    [commitScene, selectedId],
  );

  const beginPropertyEdit = useCallback(() => {
    if (!propertyStartRef.current) {
      propertyStartRef.current = cloneScene(elementsRef.current);
    }
  }, []);

  const finishPropertyEdit = useCallback(() => {
    const before = propertyStartRef.current;
    propertyStartRef.current = null;
    if (
      before &&
      JSON.stringify(before) !== JSON.stringify(elementsRef.current)
    ) {
      recordPast(before);
    }
  }, [recordPast]);

  const updateSelectedLive = useCallback(
    (patch: Partial<RectElement & LineElement>) => {
      if (!selectedId) return;
      if (selected?.locked) return;
      const next = elementsRef.current.map((element) =>
        element.id === selectedId ? ({ ...element, ...patch } as PlanElement) : element,
      );
      setSceneDirect(next);
    },
    [selected, selectedId, setSceneDirect],
  );

  const svgPoint = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const matrix = svg.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x / SCALE, y: local.y / SCALE };
  }, []);

  const snappedPoint = useCallback(
    (raw: Point, excludeId?: string, bypass = false) => {
      if (bypass) return raw;
      const gridCandidate = gridSnapEnabled
        ? {
            x: Math.round(raw.x / gridStep) * gridStep,
            y: Math.round(raw.y / gridStep) * gridStep,
          }
        : raw;
      if (!snapEnabled) return gridCandidate;
      let best = gridCandidate;
      let bestDistance = gridSnapEnabled
        ? Math.hypot(gridCandidate.x - raw.x, gridCandidate.y - raw.y)
        : Number.POSITIVE_INFINITY;
      const tolerance = Math.max(0.12, (camera.w / PLAN_WIDTH) * 0.22);
      elementsRef.current.forEach((element) => {
        if (element.id === excludeId || element.kind === "measure") return;
        scenePoints(element).forEach((point) => {
          const distance = Math.hypot(point.x - raw.x, point.y - raw.y);
          if (
            distance < tolerance &&
            (!gridSnapEnabled || distance < bestDistance)
          ) {
            best = point;
            bestDistance = distance;
          }
        });
      });
      return {
        x: roundMetric(clamp(best.x, 0, PLAN_WIDTH_M)),
        y: roundMetric(clamp(best.y, 0, PLAN_HEIGHT_M)),
      };
    },
    [camera.w, gridSnapEnabled, gridStep, snapEnabled],
  );

  const alignMovingRect = useCallback(
    (rect: RectElement, bypass: boolean, excludeIds = new Set<string>([rect.id])) => {
      if (bypass) {
        return { rect, guides: { vertical: [], horizontal: [] } as SnapGuides };
      }

      const gridAligned = gridSnapEnabled
        ? {
            ...rect,
            x: roundMetric(Math.round(rect.x / gridStep) * gridStep),
            y: roundMetric(Math.round(rect.y / gridStep) * gridStep),
          }
        : rect;
      if (!snapEnabled) {
        return {
          rect: gridAligned,
          guides: { vertical: [], horizontal: [] } as SnapGuides,
        };
      }

      const tolerance = Math.max(0.1, (camera.w / PLAN_WIDTH) * 0.18);
      const movingX = [
        gridAligned.x,
        gridAligned.x + gridAligned.w / 2,
        gridAligned.x + gridAligned.w,
      ];
      const movingY = [
        gridAligned.y,
        gridAligned.y + gridAligned.h / 2,
        gridAligned.y + gridAligned.h,
      ];
      let xOffset = 0;
      let yOffset = 0;
      let bestX = tolerance;
      let bestY = tolerance;
      let verticalGuide: number | null = null;
      let horizontalGuide: number | null = null;

      elementsRef.current.forEach((element) => {
        if (excludeIds.has(element.id) || !isRect(element)) return;
        const targetX = [element.x, element.x + element.w / 2, element.x + element.w];
        const targetY = [element.y, element.y + element.h / 2, element.y + element.h];

        movingX.forEach((source) => {
          targetX.forEach((target) => {
            const distance = Math.abs(target - source);
            if (distance < bestX) {
              bestX = distance;
              xOffset = target - source;
              verticalGuide = target;
            }
          });
        });
        movingY.forEach((source) => {
          targetY.forEach((target) => {
            const distance = Math.abs(target - source);
            if (distance < bestY) {
              bestY = distance;
              yOffset = target - source;
              horizontalGuide = target;
            }
          });
        });
      });

      const aligned = {
        ...gridAligned,
        x: roundMetric(
          clamp(gridAligned.x + xOffset, 0, PLAN_WIDTH_M - gridAligned.w),
        ),
        y: roundMetric(
          clamp(gridAligned.y + yOffset, 0, PLAN_HEIGHT_M - gridAligned.h),
        ),
      };
      return {
        rect: aligned,
        guides: {
          vertical: verticalGuide === null ? [] : [verticalGuide],
          horizontal: horizontalGuide === null ? [] : [horizontalGuide],
        },
      };
    },
    [camera.w, gridSnapEnabled, gridStep, snapEnabled],
  );

  const startMove = useCallback(
    (event: ReactPointerEvent<SVGElement>, element: PlanElement) => {
      event.preventDefault();
      event.stopPropagation();
      setSnapGuides({ vertical: [], horizontal: [] });
      const groupedIds = element.groupId
        ? elementsRef.current.filter((item) => item.groupId === element.groupId).map((item) => item.id)
        : [];
      const ids = groupedIds.length
        ? groupedIds
        : selectedIds.includes(element.id)
          ? selectedIds
          : [element.id];
      setSelectedIds(ids);
      const svg = svgRef.current;
      if (!svg) return;
      if (elementsRef.current.some((item) => ids.includes(item.id) && item.locked)) {
        showNotice("Bu seçim kilitli; taşımak için önce kilidi aç");
        return;
      }
      svg.setPointerCapture(event.pointerId);
      const syntheticPoint = svg.createSVGPoint();
      syntheticPoint.x = event.clientX;
      syntheticPoint.y = event.clientY;
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const local = syntheticPoint.matrixTransform(matrix.inverse());
      interactionRef.current =
        ids.length > 1
          ? {
              type: "move-selection",
              ids,
              start: { x: local.x / SCALE, y: local.y / SCALE },
              before: cloneScene(elementsRef.current),
            }
          : {
              type: "move",
              id: element.id,
              start: { x: local.x / SCALE, y: local.y / SCALE },
              before: cloneScene(elementsRef.current),
              original: { ...element },
            };
    },
    [selectedIds, showNotice],
  );

  const handleElementPointerDown = useCallback(
    (event: ReactPointerEvent<SVGElement>, element: PlanElement) => {
      if (tool !== "select" || event.button !== 0 || spacePressedRef.current) {
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        const memberIds = element.groupId
          ? elementsRef.current.filter((item) => item.groupId === element.groupId).map((item) => item.id)
          : [element.id];
        setSelectedIds((current) => {
          const removing = memberIds.every((id) => current.includes(id));
          return removing
            ? current.filter((id) => !memberIds.includes(id))
            : Array.from(new Set([...current, ...memberIds]));
        });
        return;
      }
      startMove(event, element);
    },
    [startMove, tool],
  );

  const startResize = useCallback(
    (
      event: ReactPointerEvent<SVGRectElement>,
      element: RectElement,
      corner: ResizeCorner,
      scene: PlanElement[],
    ) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
      interactionRef.current = {
        type: "resize",
        id: element.id,
        corner,
        before: cloneScene(scene),
        original: { ...element },
      };
    },
    [],
  );

  const startLineEndpoint = useCallback(
    (
      event: ReactPointerEvent<SVGCircleElement>,
      element: LineElement,
      endpoint: "start" | "end",
      scene: PlanElement[],
    ) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
      interactionRef.current = {
        type: "line-end",
        id: element.id,
        endpoint,
        before: cloneScene(scene),
        original: { ...element },
      };
    },
    [],
  );

  const handleStagePointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
      const panGesture =
        event.button === 1 ||
        event.button === 2 ||
        (event.button === 0 && (tool === "pan" || spacePressedRef.current));
      if (panGesture) {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        interactionRef.current = {
          type: "pan",
          startClient: { x: event.clientX, y: event.clientY },
          startCamera: { ...camera },
        };
        setIsPanning(true);
        return;
      }
      if (tool === "select") {
        setSelectedIds([]);
        return;
      }
      const point = snappedPoint(svgPoint(event), undefined, event.ctrlKey);
      if (!draft) {
        setDraft({ kind: tool, start: point, end: point });
        setSnapPoint(point);
        return;
      }
      const distance = Math.hypot(
        point.x - draft.start.x,
        point.y - draft.start.y,
      );
      if (distance < 0.05) return;
      const index = elementsRef.current.filter(
        (element) => element.kind === draft.kind,
      ).length;
      const next: LineElement = {
        id: makeId(draft.kind),
        kind: draft.kind,
        name:
          draft.kind === "wall" ? `Duvar ${index + 1}` : `Ölçü ${index + 1}`,
        x1: draft.start.x,
        y1: draft.start.y,
        x2: point.x,
        y2: point.y,
        ...(draft.kind === "wall" ? { thickness: 0.12 } : {}),
      };
      commitScene([...elementsRef.current, next]);
      setSelectedIds([next.id]);
      setDraft(null);
      setSnapPoint(null);
      showNotice(
        draft.kind === "wall"
          ? `${formatMetric(distance)} m duvar eklendi`
          : `${formatMetric(distance)} m ölçü eklendi`,
      );
    },
    [camera, commitScene, draft, showNotice, snappedPoint, svgPoint, tool],
  );

  const handleStagePointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const interaction = interactionRef.current;
      if (interaction?.type === "pan") {
        const bounds = event.currentTarget.getBoundingClientRect();
        const dx =
          ((event.clientX - interaction.startClient.x) / bounds.width) *
          interaction.startCamera.w;
        const dy =
          ((event.clientY - interaction.startClient.y) / bounds.height) *
          interaction.startCamera.h;
        setCamera({
          ...interaction.startCamera,
          x: clamp(
            interaction.startCamera.x - dx,
            0,
            PLAN_WIDTH - interaction.startCamera.w,
          ),
          y: clamp(
            interaction.startCamera.y - dy,
            0,
            PLAN_HEIGHT - interaction.startCamera.h,
          ),
        });
        return;
      }

      const raw = svgPoint(event);
      if (!interaction) {
        if (draft) {
          const point = snappedPoint(raw, undefined, event.ctrlKey);
          setDraft((current) => (current ? { ...current, end: point } : null));
          setSnapPoint(point);
        }
        return;
      }

      if (interaction.type === "move") {
        const dx = raw.x - interaction.start.x;
        const dy = raw.y - interaction.start.y;
        const original = interaction.original;
        let nextGuides: SnapGuides = { vertical: [], horizontal: [] };
        const next = interaction.before.map((element) => {
          if (element.id !== interaction.id) return element;
          if (isRect(original)) {
            const proposed: RectElement = {
              ...original,
              x: roundMetric(
                clamp(original.x + dx, 0, PLAN_WIDTH_M - original.w),
              ),
              y: roundMetric(
                clamp(original.y + dy, 0, PLAN_HEIGHT_M - original.h),
              ),
            };
            const aligned = alignMovingRect(proposed, event.ctrlKey);
            nextGuides = aligned.guides;
            return aligned.rect;
          }
          setSnapGuides({ vertical: [], horizontal: [] });
          return {
            ...original,
            x1: roundMetric(original.x1 + dx),
            y1: roundMetric(original.y1 + dy),
            x2: roundMetric(original.x2 + dx),
            y2: roundMetric(original.y2 + dy),
          };
        });
        setSnapGuides(nextGuides);
        setSceneDirect(next);
        return;
      }

      if (interaction.type === "move-selection") {
        const ids = new Set(interaction.ids);
        const moving = interaction.before.filter((item) => ids.has(item.id));
        const bounds = moving.map(elementBounds);
        const left = Math.min(...bounds.map((item) => item.left));
        const top = Math.min(...bounds.map((item) => item.top));
        const right = Math.max(...bounds.map((item) => item.right));
        const bottom = Math.max(...bounds.map((item) => item.bottom));
        let dx = clamp(raw.x - interaction.start.x, -left, PLAN_WIDTH_M - right);
        let dy = clamp(raw.y - interaction.start.y, -top, PLAN_HEIGHT_M - bottom);
        const proposedBounds: RectElement = {
          id: "__selection__",
          kind: "object",
          name: "Seçim",
          color: "#d946ef",
          x: left + dx,
          y: top + dy,
          w: right - left,
          h: bottom - top,
        };
        const aligned = alignMovingRect(proposedBounds, event.ctrlKey, ids);
        dx += aligned.rect.x - proposedBounds.x;
        dy += aligned.rect.y - proposedBounds.y;
        setSnapGuides(aligned.guides);
        setSceneDirect(
          interaction.before.map((element) => {
            if (!ids.has(element.id)) return element;
            if (isRect(element)) {
              return {
                ...element,
                x: roundMetric(element.x + dx),
                y: roundMetric(element.y + dy),
              };
            }
            return {
              ...element,
              x1: roundMetric(element.x1 + dx),
              y1: roundMetric(element.y1 + dy),
              x2: roundMetric(element.x2 + dx),
              y2: roundMetric(element.y2 + dy),
            };
          }),
        );
        return;
      }

      if (interaction.type === "resize") {
        const point = snappedPoint(raw, interaction.id, event.ctrlKey);
        const snappedX = Math.abs(point.x - raw.x) > 0.001;
        const snappedY = Math.abs(point.y - raw.y) > 0.001;
        setSnapGuides(
          event.ctrlKey || !snapEnabled
            ? { vertical: [], horizontal: [] }
            : {
                vertical: snappedX ? [point.x] : [],
                horizontal: snappedY ? [point.y] : [],
              },
        );
        const original = interaction.original;
        const right = original.x + original.w;
        const bottom = original.y + original.h;
        let left = original.x;
        let top = original.y;
        let nextRight = right;
        let nextBottom = bottom;

        if (interaction.corner.includes("w")) {
          left = Math.min(point.x, right - MIN_RECT_SIZE);
        }
        if (interaction.corner.includes("e")) {
          nextRight = Math.max(point.x, original.x + MIN_RECT_SIZE);
        }
        if (interaction.corner.includes("n")) {
          top = Math.min(point.y, bottom - MIN_RECT_SIZE);
        }
        if (interaction.corner.includes("s")) {
          nextBottom = Math.max(point.y, original.y + MIN_RECT_SIZE);
        }

        const resized: RectElement = {
          ...original,
          x: roundMetric(clamp(left, 0, PLAN_WIDTH_M)),
          y: roundMetric(clamp(top, 0, PLAN_HEIGHT_M)),
          w: roundMetric(clamp(nextRight - left, MIN_RECT_SIZE, PLAN_WIDTH_M)),
          h: roundMetric(clamp(nextBottom - top, MIN_RECT_SIZE, PLAN_HEIGHT_M)),
        };
        setSceneDirect(
          interaction.before.map((element) =>
            element.id === interaction.id ? resized : element,
          ),
        );
        return;
      }

      const point = snappedPoint(raw, interaction.id, event.ctrlKey);
      const changed: LineElement = {
        ...interaction.original,
        ...(interaction.endpoint === "start"
          ? { x1: point.x, y1: point.y }
          : { x2: point.x, y2: point.y }),
      };
      setSceneDirect(
        interaction.before.map((element) =>
          element.id === interaction.id ? changed : element,
        ),
      );
    },
    [alignMovingRect, draft, setSceneDirect, snapEnabled, snappedPoint, svgPoint],
  );

  const finishInteraction = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const interaction = interactionRef.current;
      if (!interaction) return;
      if (
        interaction.type !== "pan" &&
        JSON.stringify(interaction.before) !== JSON.stringify(elementsRef.current)
      ) {
        recordPast(interaction.before);
      }
      interactionRef.current = null;
      setSnapGuides({ vertical: [], horizontal: [] });
      setIsPanning(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [recordPast],
  );

  const zoomAtCenter = useCallback((factor: number) => {
    setCamera((current) => {
      const nextW = clamp(current.w * factor, 280, PLAN_WIDTH);
      const nextH = (nextW / PLAN_WIDTH) * PLAN_HEIGHT;
      const centerX = current.x + current.w / 2;
      const centerY = current.y + current.h / 2;
      return {
        x: clamp(centerX - nextW / 2, 0, PLAN_WIDTH - nextW),
        y: clamp(centerY - nextH / 2, 0, PLAN_HEIGHT - nextH),
        w: nextW,
        h: nextH,
      };
    });
  }, []);

  const handleWheel = useCallback((event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const local = point.matrixTransform(matrix.inverse());
    const factor = event.deltaY > 0 ? 1.12 : 0.88;
    setCamera((current) => {
      const nextW = clamp(current.w * factor, 280, PLAN_WIDTH);
      const nextH = (nextW / PLAN_WIDTH) * PLAN_HEIGHT;
      const ratioX = (local.x - current.x) / current.w;
      const ratioY = (local.y - current.y) / current.h;
      return {
        x: clamp(local.x - ratioX * nextW, 0, PLAN_WIDTH - nextW),
        y: clamp(local.y - ratioY * nextH, 0, PLAN_HEIGHT - nextH),
        w: nextW,
        h: nextH,
      };
    });
  }, []);

  const fitPlan = useCallback(() => {
    setCamera({ x: 0, y: 0, w: PLAN_WIDTH, h: PLAN_HEIGHT });
  }, []);

  const exportPlan = useCallback(() => {
    const payload = {
      version: 1,
      title: "Mağaza planım",
      exportedAt: new Date().toISOString(),
      elements: elementsRef.current,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "magaza-planim.json";
    anchor.click();
    URL.revokeObjectURL(url);
    showNotice("Plan dosyası indirildi");
  }, [showNotice]);

  const importPlan = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const imported = validateImportedScene(parsed);
        if (!imported) throw new Error("invalid");
        commitScene(cloneScene(imported));
        setSelectedIds([]);
        fitPlan();
        showNotice("Plan açıldı");
      } catch {
        showNotice("Bu plan dosyası açılamadı");
      }
    },
    [commitScene, fitPlan, showNotice],
  );

  const clearPlan = useCallback(() => {
    if (!window.confirm("Plandaki tüm oda, duvar, eşya ve ölçüler silinsin mi?")) {
      return;
    }
    commitScene([]);
    setSelectedIds([]);
    setDraft(null);
    showNotice("Boş plan hazır");
  }, [commitScene, showNotice]);

  const restoreExample = useCallback(() => {
    if (!window.confirm("Mevcut plan örnek dükkân yerleşimiyle değiştirilsin mi?")) {
      return;
    }
    commitScene(cloneScene(INITIAL_ELEMENTS));
    setSelectedIds(["rack-oval"]);
    setDraft(null);
    fitPlan();
    showNotice("Örnek dükkân geri yüklendi");
  }, [commitScene, fitPlan, showNotice]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "SELECT" ||
        target?.tagName === "TEXTAREA"
      ) {
        return;
      }
      const modifier = event.ctrlKey || event.metaKey;
      if (event.code === "Space") {
        event.preventDefault();
        spacePressedRef.current = true;
        setIsSpacePressed(true);
      } else if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (modifier && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if (modifier && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelected();
      } else if (modifier && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copySelected();
      } else if (modifier && event.key.toLowerCase() === "v") {
        event.preventDefault();
        pasteCopied();
      } else if (modifier && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(elementsRef.current.map((item) => item.id));
      } else if (modifier && event.key.toLowerCase() === "g") {
        event.preventDefault();
        if (event.shiftKey) ungroupSelection();
        else groupSelection();
      } else if (modifier && event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        toggleLockSelection();
      } else if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        const step = event.shiftKey ? 0.1 : 0.01;
        if (event.key === "ArrowLeft") nudgeSelected(-step, 0);
        if (event.key === "ArrowRight") nudgeSelected(step, 0);
        if (event.key === "ArrowUp") nudgeSelected(0, -step);
        if (event.key === "ArrowDown") nudgeSelected(0, step);
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelected();
      } else if (event.key === "Escape") {
        if (shortcutsOpen) {
          setShortcutsOpen(false);
          return;
        }
        setDraft(null);
        setSnapPoint(null);
        setSnapGuides({ vertical: [], horizontal: [] });
        setSelectedIds([]);
        setTool("select");
      } else if (event.key === "?") {
        setShortcutsOpen(true);
      } else if (event.key.toLowerCase() === "v") {
        setTool("select");
      } else if (event.key.toLowerCase() === "h") {
        setTool("pan");
      } else if (event.key.toLowerCase() === "w") {
        setTool("wall");
      } else if (event.key.toLowerCase() === "m") {
        setTool("measure");
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      spacePressedRef.current = false;
      setIsSpacePressed(false);
    };
    const handleBlur = () => {
      spacePressedRef.current = false;
      setIsSpacePressed(false);
      setIsPanning(false);
    };
    window.addEventListener("keydown", handleKey);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [copySelected, deleteSelected, duplicateSelected, groupSelection, nudgeSelected, pasteCopied, redo, shortcutsOpen, toggleLockSelection, undo, ungroupSelection]);

  const orderedElements = useMemo(() => {
    const priority: Record<PlanElement["kind"], number> = {
      room: 0,
      wall: 1,
      object: 2,
      measure: 3,
    };
    return elements
      .map((element, index) => ({ element, index }))
      .sort(
        (a, b) =>
          priority[a.element.kind] - priority[b.element.kind] || a.index - b.index,
      )
      .map(({ element }) => element);
  }, [elements]);

  const handleSize = 9 * (camera.w / PLAN_WIDTH);
  const zoomPercent = Math.round((PLAN_WIDTH / camera.w) * 100);
  const instruction =
    tool === "select"
      ? "Kenar ve merkezlere akıllı hizalar. Ctrl basılıyken serbest taşı."
      : tool === "pan"
        ? "Planı görmek istediğin yöne sürükle. Fare tekeriyle yakınlaş."
        : draft
          ? "İkinci noktayı seç. Esc ile iptal edebilirsin."
          : tool === "wall"
            ? "Duvarın başlangıç noktasını seç."
            : "Ölçülecek ilk noktayı seç; köşe ve orta noktalar yakalanır.";

  const renderElement = (element: PlanElement) => {
    const isSelected = selectedIds.includes(element.id);
    if (isRect(element)) {
      const x = element.x * SCALE;
      const y = element.y * SCALE;
      const w = element.w * SCALE;
      const h = element.h * SCALE;
      const labelFits = w > 75 && h > 34;
      return (
        <g
          key={element.id}
          className={`plan-element ${element.kind} ${isSelected ? "selected" : ""} ${element.locked ? "locked" : ""}`}
          onPointerDown={(event) => handleElementPointerDown(event, element)}
          aria-label={`${TYPE_LABELS[element.kind]}: ${element.name}`}
        >
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            rx={element.kind === "object" ? 5 : 1}
            fill={element.color}
            fillOpacity={element.kind === "room" ? 0.08 : 0.2}
            stroke={element.color}
            strokeWidth={isSelected ? 3 : element.kind === "room" ? 2.2 : 1.8}
            vectorEffect="non-scaling-stroke"
          />
          {element.kind === "object" && element.name.includes("raf") && (
            <g className="rack-lines" aria-hidden="true">
              <line x1={x + w / 3} y1={y + 4} x2={x + w / 3} y2={y + h - 4} />
              <line
                x1={x + (w * 2) / 3}
                y1={y + 4}
                x2={x + (w * 2) / 3}
                y2={y + h - 4}
              />
            </g>
          )}
          {labelFits && (
            <g className="element-label" pointerEvents="none">
              <text x={x + w / 2} y={y + h / 2 - 3} textAnchor="middle">
                {element.name.length > 28
                  ? `${element.name.slice(0, 27)}…`
                  : element.name}
              </text>
              <text
                className="element-dimension"
                x={x + w / 2}
                y={y + h / 2 + 15}
                textAnchor="middle"
              >
                {formatMetric(element.w)} × {formatMetric(element.h)} m
              </text>
            </g>
          )}
          {element.locked && (
            <text className="lock-indicator" x={x + w - 8} y={y + 15} textAnchor="end" pointerEvents="none">🔒</text>
          )}
        </g>
      );
    }

    const x1 = element.x1 * SCALE;
    const y1 = element.y1 * SCALE;
    const x2 = element.x2 * SCALE;
    const y2 = element.y2 * SCALE;
    const length = lineLength(element);
    const middleX = (x1 + x2) / 2;
    const middleY = (y1 + y2) / 2;
    const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    const readableAngle = angle > 90 || angle < -90 ? angle + 180 : angle;

    return (
      <g
        key={element.id}
        className={`plan-element ${element.kind} ${isSelected ? "selected" : ""} ${element.locked ? "locked" : ""}`}
        onPointerDown={(event) => handleElementPointerDown(event, element)}
        aria-label={`${TYPE_LABELS[element.kind]}: ${element.name}`}
      >
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="transparent"
          strokeWidth={18}
          vectorEffect="non-scaling-stroke"
        />
        {element.kind === "wall" ? (
          <line
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            className="wall-line"
            strokeWidth={(element.thickness ?? 0.12) * SCALE}
          />
        ) : (
          <g className="measure-line">
            <line x1={x1} y1={y1} x2={x2} y2={y2} />
            <line x1={x1 - 6} y1={y1} x2={x1 + 6} y2={y1} />
            <line x1={x2 - 6} y1={y2} x2={x2 + 6} y2={y2} />
          </g>
        )}
        <text
          className={`line-label ${element.kind}`}
          x={middleX}
          y={middleY - 8}
          textAnchor="middle"
          transform={`rotate(${readableAngle} ${middleX} ${middleY - 8})`}
          pointerEvents="none"
        >
          {element.kind === "measure" ? "↔ " : ""}
          {formatMetric(length)} m
        </text>
        {element.locked && (
          <text className="lock-indicator" x={middleX + 12} y={middleY + 18} pointerEvents="none">🔒</text>
        )}
      </g>
    );
  };

  const selectedRect = selected && isRect(selected) && !selected.locked ? selected : null;
  const selectedLine = selected && isLine(selected) && !selected.locked ? selected : null;
  const multiSelectionBounds = selection.length > 1
    ? (() => {
        const bounds = selection.map(elementBounds);
        return {
          left: Math.min(...bounds.map((item) => item.left)),
          top: Math.min(...bounds.map((item) => item.top)),
          right: Math.max(...bounds.map((item) => item.right)),
          bottom: Math.max(...bounds.map((item) => item.bottom)),
        };
      })()
    : null;
  const rectHandles = selectedRect
    ? [
        { corner: "nw" as const, x: selectedRect.x, y: selectedRect.y },
        {
          corner: "ne" as const,
          x: selectedRect.x + selectedRect.w,
          y: selectedRect.y,
        },
        {
          corner: "se" as const,
          x: selectedRect.x + selectedRect.w,
          y: selectedRect.y + selectedRect.h,
        },
        {
          corner: "sw" as const,
          x: selectedRect.x,
          y: selectedRect.y + selectedRect.h,
        },
      ]
    : [];

  return (
    <main className="planner-app">
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            MP
          </div>
          <div>
            <h1>Mağaza Planlayıcı</h1>
            <p>Ölçülü oda ve raf yerleşimi</p>
          </div>
        </div>

        <div className="header-actions" aria-label="Plan işlemleri">
          <span className="save-state">
            <span className="save-dot" aria-hidden="true" />
            {saveLabel}
          </span>
          <button className="quiet-button" onClick={undo} disabled={!past.length}>
            ↶ <span>Geri al</span>
          </button>
          <button className="quiet-button" onClick={redo} disabled={!future.length}>
            ↷ <span>Yinele</span>
          </button>
          <button className="quiet-button" onClick={() => setShortcutsOpen(true)}>
            ? <span>Kısayollar</span>
          </button>
          <button
            className="quiet-button"
            onClick={() => fileInputRef.current?.click()}
          >
            ↑ <span>Plan aç</span>
          </button>
          <button className="primary-button" onClick={exportPlan}>
            ↓ Planı indir
          </button>
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="application/json,.json"
            onChange={importPlan}
          />
        </div>
      </header>

      <div className="workspace">
        <aside className="tool-panel" aria-label="Plan araçları">
          <section className="panel-section">
            <div className="section-heading">
              <span>Araçlar</span>
              <span className="section-hint">Kısayol</span>
            </div>
            <div className="tool-grid">
              {(
                [
                  ["select", "Seç ve taşı", "V", "↖"],
                  ["pan", "Görünümü gez", "H", "✋"],
                  ["wall", "Duvar çiz", "W", "╱"],
                  ["measure", "Mesafe ölç", "M", "↔"],
                ] as [Tool, string, string, string][]
              ).map(([value, label, shortcut, icon]) => (
                <button
                  key={value}
                  className={`tool-button ${tool === value ? "active" : ""}`}
                  aria-pressed={tool === value}
                  onClick={() => {
                    setTool(value);
                    setDraft(null);
                    setSnapPoint(null);
                  }}
                >
                  <span className="tool-icon" aria-hidden="true">
                    {icon}
                  </span>
                  <span>{label}</span>
                  <kbd>{shortcut}</kbd>
                </button>
              ))}
            </div>
          </section>

          <section className="panel-section">
            <div className="section-heading">
              <span>Yapı</span>
            </div>
            <button className="add-room-button" onClick={() => addRect("room")}>
              <span aria-hidden="true">＋</span>
              <span>
                <strong>Yeni oda / alan</strong>
                <small>3,00 × 2,40 m ile başlar</small>
              </span>
            </button>
          </section>

          <section className="panel-section catalog-section">
            <div className="section-heading">
              <span>Eşya kütüphanesi</span>
              <span className="section-hint">Tıkla ve ekle</span>
            </div>
            <div className="catalog-grid">
              {OBJECT_PRESETS.map((preset) => (
                <button
                  className="catalog-item"
                  key={preset.name}
                  onClick={() => addRect("object", preset)}
                >
                  <span
                    className="catalog-swatch"
                    style={{ backgroundColor: preset.color }}
                    aria-hidden="true"
                  />
                  <span>
                    <strong>{preset.name}</strong>
                    <small>{preset.note}</small>
                  </span>
                  <span className="catalog-plus" aria-hidden="true">
                    +
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="panel-section plan-actions">
            <button className="text-button" onClick={restoreExample}>
              Örnek dükkânı geri yükle
            </button>
            <button className="text-button danger" onClick={clearPlan}>
              Boş plan oluştur
            </button>
          </section>
        </aside>

        <section className="stage-panel" aria-label="Çizim alanı">
          <div className="stage-toolbar">
            <div className="instruction">
              <span className={`mode-dot ${tool}`} aria-hidden="true" />
              <span>{instruction}</span>
            </div>
            <div className="view-controls">
              <label className="compact-select">
                <span>Izgara</span>
                <select
                  value={gridStep}
                  onChange={(event) => setGridStep(Number(event.target.value))}
                >
                  <option value={0.1}>10 cm</option>
                  <option value={0.25}>25 cm</option>
                  <option value={0.5}>50 cm</option>
                  <option value={1}>1 m</option>
                </select>
              </label>
              <button
                className={`toggle-button ${gridVisible ? "active" : ""}`}
                aria-pressed={gridVisible}
                onClick={() => setGridVisible((value) => !value)}
              >
                Izgara
              </button>
              <button
                className={`toggle-button ${gridSnapEnabled ? "active" : ""}`}
                aria-pressed={gridSnapEnabled}
                title="Nesneleri seçili ızgara aralığına hizala"
                onClick={() => {
                  setGridSnapEnabled((value) => !value);
                  setSnapGuides({ vertical: [], horizontal: [] });
                }}
              >
                Izgaraya hizala
              </button>
              <button
                className={`toggle-button ${snapEnabled ? "active" : ""}`}
                aria-pressed={snapEnabled}
                onClick={() => {
                  setSnapEnabled((value) => !value);
                  setSnapGuides({ vertical: [], horizontal: [] });
                }}
              >
                Akıllı hizala
              </button>
              <span className="toolbar-divider" aria-hidden="true" />
              <button
                className="icon-button"
                aria-label="Uzaklaştır"
                onClick={() => zoomAtCenter(1.16)}
              >
                −
              </button>
              <span className="zoom-value">%{zoomPercent}</span>
              <button
                className="icon-button"
                aria-label="Yakınlaştır"
                onClick={() => zoomAtCenter(0.86)}
              >
                +
              </button>
              <button className="fit-button" onClick={fitPlan}>
                Sığdır
              </button>
            </div>
          </div>

          <div className="stage-viewport">
            <div className="ruler ruler-horizontal" aria-hidden="true">
              {Array.from({ length: PLAN_WIDTH_M + 1 }, (_, index) => (
                <span key={index} style={{ left: `${(index / PLAN_WIDTH_M) * 100}%` }}>
                  {index} m
                </span>
              ))}
            </div>
            <div className="ruler ruler-vertical" aria-hidden="true">
              {Array.from({ length: PLAN_HEIGHT_M + 1 }, (_, index) => (
                <span key={index} style={{ top: `${(index / PLAN_HEIGHT_M) * 100}%` }}>
                  {index}
                </span>
              ))}
            </div>
            <svg
              ref={svgRef}
              className={`plan-stage tool-${tool} ${isSpacePressed ? "space-ready" : ""} ${isPanning ? "is-panning" : ""}`}
              viewBox={`${camera.x} ${camera.y} ${camera.w} ${camera.h}`}
              role="application"
              aria-label="Mağaza planı düzenleme alanı"
              onPointerDown={handleStagePointerDown}
              onPointerMove={handleStagePointerMove}
              onPointerUp={finishInteraction}
              onPointerCancel={finishInteraction}
              onContextMenu={(event) => event.preventDefault()}
              onWheel={handleWheel}
            >
              <defs>
                <pattern
                  id="minor-grid"
                  width={gridStep * SCALE}
                  height={gridStep * SCALE}
                  patternUnits="userSpaceOnUse"
                >
                  <path
                    d={`M ${gridStep * SCALE} 0 L 0 0 0 ${gridStep * SCALE}`}
                    className="minor-grid-line"
                    fill="none"
                  />
                </pattern>
                <pattern
                  id="major-grid"
                  width={SCALE}
                  height={SCALE}
                  patternUnits="userSpaceOnUse"
                >
                  <rect width={SCALE} height={SCALE} fill="url(#minor-grid)" />
                  <path
                    d={`M ${SCALE} 0 L 0 0 0 ${SCALE}`}
                    className="major-grid-line"
                    fill="none"
                  />
                </pattern>
                <marker
                  id="measure-arrow-start"
                  markerWidth="7"
                  markerHeight="7"
                  refX="1"
                  refY="3.5"
                  orient="auto"
                >
                  <path d="M7,0 L0,3.5 L7,7" className="measure-arrow" />
                </marker>
                <marker
                  id="measure-arrow-end"
                  markerWidth="7"
                  markerHeight="7"
                  refX="6"
                  refY="3.5"
                  orient="auto"
                >
                  <path d="M0,0 L7,3.5 L0,7" className="measure-arrow" />
                </marker>
              </defs>

              <rect
                x="0"
                y="0"
                width={PLAN_WIDTH}
                height={PLAN_HEIGHT}
                className="canvas-background"
              />
              {gridVisible && (
                <rect
                  x="0"
                  y="0"
                  width={PLAN_WIDTH}
                  height={PLAN_HEIGHT}
                  fill="url(#major-grid)"
                  pointerEvents="none"
                />
              )}

              {orderedElements.map(renderElement)}

              {multiSelectionBounds && (
                <rect
                  className="multi-selection-bounds"
                  x={multiSelectionBounds.left * SCALE - 5}
                  y={multiSelectionBounds.top * SCALE - 5}
                  width={(multiSelectionBounds.right - multiSelectionBounds.left) * SCALE + 10}
                  height={(multiSelectionBounds.bottom - multiSelectionBounds.top) * SCALE + 10}
                  rx={5}
                  pointerEvents="none"
                />
              )}

              {(snapGuides.vertical.length > 0 ||
                snapGuides.horizontal.length > 0) && (
                <g className="alignment-guides" pointerEvents="none">
                  {snapGuides.vertical.map((x) => (
                    <line
                      key={`v-${x}`}
                      x1={x * SCALE}
                      y1={0}
                      x2={x * SCALE}
                      y2={PLAN_HEIGHT}
                    />
                  ))}
                  {snapGuides.horizontal.map((y) => (
                    <line
                      key={`h-${y}`}
                      x1={0}
                      y1={y * SCALE}
                      x2={PLAN_WIDTH}
                      y2={y * SCALE}
                    />
                  ))}
                </g>
              )}

              {draft && (
                <g className={`draft-line ${draft.kind}`} pointerEvents="none">
                  <line
                    x1={draft.start.x * SCALE}
                    y1={draft.start.y * SCALE}
                    x2={draft.end.x * SCALE}
                    y2={draft.end.y * SCALE}
                  />
                  <circle cx={draft.start.x * SCALE} cy={draft.start.y * SCALE} r={5} />
                  <circle cx={draft.end.x * SCALE} cy={draft.end.y * SCALE} r={5} />
                  <text
                    x={((draft.start.x + draft.end.x) / 2) * SCALE}
                    y={((draft.start.y + draft.end.y) / 2) * SCALE - 10}
                    textAnchor="middle"
                  >
                    {formatMetric(
                      Math.hypot(
                        draft.end.x - draft.start.x,
                        draft.end.y - draft.start.y,
                      ),
                    )}{" "}
                    m
                  </text>
                </g>
              )}

              {snapPoint && (
                <g className="snap-indicator" pointerEvents="none">
                  <circle cx={snapPoint.x * SCALE} cy={snapPoint.y * SCALE} r={7} />
                  <circle cx={snapPoint.x * SCALE} cy={snapPoint.y * SCALE} r={2} />
                </g>
              )}

              {selectedRect &&
                rectHandles.map((handle) => (
                  <rect
                    key={handle.corner}
                    className={`resize-handle handle-${handle.corner}`}
                    x={handle.x * SCALE - handleSize / 2}
                    y={handle.y * SCALE - handleSize / 2}
                    width={handleSize}
                    height={handleSize}
                    rx={2}
                    onPointerDown={(event) =>
                      startResize(event, selectedRect, handle.corner, elements)
                    }
                  />
                ))}

              {selectedLine && (
                <g className="line-handles">
                  <circle
                    cx={selectedLine.x1 * SCALE}
                    cy={selectedLine.y1 * SCALE}
                    r={handleSize * 0.65}
                    onPointerDown={(event) =>
                      startLineEndpoint(event, selectedLine, "start", elements)
                    }
                  />
                  <circle
                    cx={selectedLine.x2 * SCALE}
                    cy={selectedLine.y2 * SCALE}
                    r={handleSize * 0.65}
                    onPointerDown={(event) =>
                      startLineEndpoint(event, selectedLine, "end", elements)
                    }
                  />
                </g>
              )}

              <rect
                x="0"
                y="0"
                width={PLAN_WIDTH}
                height={PLAN_HEIGHT}
                className="canvas-border"
                pointerEvents="none"
              />
            </svg>
          </div>

          <div className="stage-status">
            <span>
              Çalışma alanı: {PLAN_WIDTH_M} × {PLAN_HEIGHT_M} m
            </span>
            <span>Izgara: {gridStep * 100} cm</span>
            <span>
              Izgara hizası: {gridSnapEnabled ? "Açık" : "Kapalı"}
            </span>
            <span>Ctrl: serbest yerleştir</span>
            <span>Sağ tuş / Space: gezin</span>
            <span>Ctrl + tık: çoklu seç</span>
            <span>Oklar: 1 cm taşı</span>
            <span>Fare tekeri: yakınlaştır</span>
            <span>Delete: sil</span>
          </div>
        </section>

        <aside className="inspector-panel" aria-label="Özellikler">
          {selection.length > 1 ? (
            <>
              <div className="inspector-heading">
                <div>
                  <span className="type-badge object">Çoklu seçim</span>
                  <h2>{selection.length} öğe seçildi</h2>
                </div>
                <button
                  className="close-selection"
                  aria-label="Seçimi kapat"
                  onClick={() => setSelectedIds([])}
                >
                  ×
                </button>
              </div>
              <div className="multi-selection-note">
                <strong>Birlikte düzenle</strong>
                <p>Seçimi sürükleyerek birlikte taşıyabilir, gruplayabilir veya kilitleyebilirsin.</p>
              </div>
              <div className="property-group">
                <h3>Grup ve koruma</h3>
                <div className="action-grid">
                  <button onClick={groupSelection} disabled={selectionGrouped}>Grupla</button>
                  <button onClick={ungroupSelection} disabled={!selectionGrouped}>Grubu çöz</button>
                  <button onClick={toggleLockSelection}>
                    {selectionLocked ? "Kilidi aç" : "Kilitle"}
                  </button>
                  <button onClick={duplicateSelected}>Çoğalt</button>
                </div>
                <button className="delete-button" onClick={deleteSelected}>
                  Seçili öğeleri sil
                </button>
              </div>
            </>
          ) : selected ? (
            <>
              <div className="inspector-heading">
                <div>
                  <span className={`type-badge ${selected.kind}`}>
                    {TYPE_LABELS[selected.kind]}
                  </span>
                  <h2>Özellikler</h2>
                </div>
                <button
                  className="close-selection"
                  aria-label="Seçimi kapat"
                  onClick={() => setSelectedIds([])}
                >
                  ×
                </button>
              </div>

              <div className="property-group">
                <label className="field-label" htmlFor="element-name">
                  İsim
                </label>
                <input
                  id="element-name"
                  className="text-input"
                  value={selected.name}
                  onFocus={beginPropertyEdit}
                  onBlur={finishPropertyEdit}
                  onChange={(event) =>
                    updateSelectedLive({ name: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </div>

              {isRect(selected) ? (
                <>
                  <div className="property-group">
                    <h3>Konum</h3>
                    <div className="number-grid">
                      <MetricInput
                        label="X"
                        value={selected.x}
                        onFocus={beginPropertyEdit}
                        onBlur={finishPropertyEdit}
                        onChange={(value) => updateSelectedLive({ x: value })}
                      />
                      <MetricInput
                        label="Y"
                        value={selected.y}
                        onFocus={beginPropertyEdit}
                        onBlur={finishPropertyEdit}
                        onChange={(value) => updateSelectedLive({ y: value })}
                      />
                    </div>
                  </div>
                  <div className="property-group">
                    <h3>Ölçüler</h3>
                    <div className="number-grid">
                      <MetricInput
                        label="Genişlik"
                        value={selected.w}
                        min={MIN_RECT_SIZE}
                        onFocus={beginPropertyEdit}
                        onBlur={finishPropertyEdit}
                        onChange={(value) => updateSelectedLive({ w: value })}
                      />
                      <MetricInput
                        label="Derinlik"
                        value={selected.h}
                        min={MIN_RECT_SIZE}
                        onFocus={beginPropertyEdit}
                        onBlur={finishPropertyEdit}
                        onChange={(value) => updateSelectedLive({ h: value })}
                      />
                    </div>
                    <div className="calculated-value">
                      <span>Kapladığı alan</span>
                      <strong>{formatMetric(selected.w * selected.h)} m²</strong>
                    </div>
                  </div>
                  <div className="property-group color-row">
                    <label htmlFor="element-color">Renk</label>
                    <input
                      id="element-color"
                      type="color"
                      value={selected.color}
                      onFocus={beginPropertyEdit}
                      onBlur={finishPropertyEdit}
                      onChange={(event) =>
                        updateSelectedLive({ color: event.target.value })
                      }
                    />
                    <span>{selected.color.toUpperCase()}</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="property-group">
                    <h3>Noktalar</h3>
                    <div className="endpoint-block">
                      <span>Başlangıç</span>
                      <div className="number-grid">
                        <MetricInput
                          label="X₁"
                          value={selected.x1}
                          onFocus={beginPropertyEdit}
                          onBlur={finishPropertyEdit}
                          onChange={(value) => updateSelectedLive({ x1: value })}
                        />
                        <MetricInput
                          label="Y₁"
                          value={selected.y1}
                          onFocus={beginPropertyEdit}
                          onBlur={finishPropertyEdit}
                          onChange={(value) => updateSelectedLive({ y1: value })}
                        />
                      </div>
                    </div>
                    <div className="endpoint-block">
                      <span>Bitiş</span>
                      <div className="number-grid">
                        <MetricInput
                          label="X₂"
                          value={selected.x2}
                          onFocus={beginPropertyEdit}
                          onBlur={finishPropertyEdit}
                          onChange={(value) => updateSelectedLive({ x2: value })}
                        />
                        <MetricInput
                          label="Y₂"
                          value={selected.y2}
                          onFocus={beginPropertyEdit}
                          onBlur={finishPropertyEdit}
                          onChange={(value) => updateSelectedLive({ y2: value })}
                        />
                      </div>
                    </div>
                    <div className="calculated-value emphasized">
                      <span>Toplam uzunluk</span>
                      <strong>{formatMetric(lineLength(selected))} m</strong>
                    </div>
                  </div>
                  {selected.kind === "wall" && (
                    <div className="property-group">
                      <MetricInput
                        label="Duvar kalınlığı"
                        value={selected.thickness ?? 0.12}
                        min={0.05}
                        step={0.01}
                        onFocus={beginPropertyEdit}
                        onBlur={finishPropertyEdit}
                        onChange={(value) =>
                          updateSelectedLive({ thickness: value })
                        }
                      />
                    </div>
                  )}
                </>
              )}

              <div className="property-group">
                <h3>Düzenle</h3>
                <div className="action-grid">
                  <button onClick={duplicateSelected}>Kopyala</button>
                  <button onClick={rotateSelected} disabled={!isRect(selected)}>
                    90° döndür
                  </button>
                  <button onClick={() => moveLayer("front")}>Öne getir</button>
                  <button onClick={() => moveLayer("back")}>Arkaya al</button>
                  <button onClick={toggleLockSelection}>
                    {selected.locked ? "Kilidi aç" : "Kilitle"}
                  </button>
                  {selected.groupId && <button onClick={ungroupSelection}>Grubu çöz</button>}
                </div>
                <button className="delete-button" onClick={deleteSelected}>
                  Seçili nesneyi sil
                </button>
              </div>
            </>
          ) : (
            <div className="empty-inspector">
              <div className="empty-icon" aria-hidden="true">
                ↖
              </div>
              <h2>Bir nesne seç</h2>
              <p>
                Oda, duvar, eşya veya ölçüyü seçtiğinde ismini ve tüm ölçülerini
                buradan değiştirebilirsin.
              </p>
              <ol>
                <li>Soldan oda veya eşya ekle.</li>
                <li>Sürükleyerek yerine taşı.</li>
                <li>Köşelerinden tutup boyutlandır.</li>
              </ol>
            </div>
          )}

          <div className="plan-summary">
            <div className="summary-heading">
              <h3>Plan özeti</h3>
              <span>{elements.length} öğe</span>
            </div>
            <div className="summary-grid">
              <div>
                <strong>{counts.rooms}</strong>
                <span>Oda</span>
              </div>
              <div>
                <strong>{counts.objects}</strong>
                <span>Eşya</span>
              </div>
              <div>
                <strong>{counts.walls}</strong>
                <span>Duvar</span>
              </div>
              <div>
                <strong>{counts.measures}</strong>
                <span>Ölçü</span>
              </div>
            </div>
            <div className="total-area">
              <span>Toplam oda alanı</span>
              <strong>{formatMetric(roomArea, 1)} m²</strong>
            </div>
          </div>
        </aside>
      </div>

      {notice && (
        <div className="toast" role="status">
          <span aria-hidden="true">✓</span> {notice}
        </div>
      )}

      {shortcutsOpen && (
        <div className="shortcut-backdrop" onPointerDown={() => setShortcutsOpen(false)}>
          <section
            className="shortcut-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcut-title"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="shortcut-heading">
              <div>
                <span>Hızlı kullanım</span>
                <h2 id="shortcut-title">Klavye ve fare kısayolları</h2>
              </div>
              <button aria-label="Kısayolları kapat" onClick={() => setShortcutsOpen(false)}>×</button>
            </div>
            <div className="shortcut-list">
              <Shortcut keys="Sağ tuş + sürükle" label="Plan üzerinde gezin" />
              <Shortcut keys="Space + sürükle" label="Geçici el aracı" />
              <Shortcut keys="Fare tekeri" label="Yakınlaştır / uzaklaştır" />
              <Shortcut keys="Ctrl basılı" label="Hizalamayı geçici kapat" />
              <Shortcut keys="Yön tuşları" label="Seçileni 1 cm taşı" />
              <Shortcut keys="Shift + yön" label="Seçileni 10 cm taşı" />
              <Shortcut keys="Ctrl + C / V" label="Kopyala / yapıştır" />
              <Shortcut keys="Ctrl + sol tık" label="Çoklu seçim yap" />
              <Shortcut keys="Ctrl + A" label="Tüm öğeleri seç" />
              <Shortcut keys="Ctrl + G" label="Seçimi grupla" />
              <Shortcut keys="Ctrl + Shift + G" label="Grubu çöz" />
              <Shortcut keys="Ctrl + Shift + L" label="Kilitle / kilidi aç" />
              <Shortcut keys="Ctrl + D" label="Hızlı çoğalt" />
              <Shortcut keys="Ctrl + Z / Y" label="Geri al / yinele" />
              <Shortcut keys="Delete" label="Seçileni sil" />
              <Shortcut keys="Esc" label="Seçimi veya aracı bırak" />
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="shortcut-row">
      <kbd>{keys}</kbd>
      <span>{label}</span>
    </div>
  );
}

function MetricInput({
  label,
  value,
  onChange,
  onFocus,
  onBlur,
  min = 0,
  step = 0.01,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onFocus: () => void;
  onBlur: () => void;
  min?: number;
  step?: number;
}) {
  return (
    <label className="metric-input">
      <span>{label}</span>
      <span className="input-with-unit">
        <input
          type="number"
          min={min}
          max={99}
          step={step}
          value={Number.isFinite(value) ? value : 0}
          onFocus={onFocus}
          onBlur={onBlur}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(Math.max(min, next));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <em>m</em>
      </span>
    </label>
  );
}
