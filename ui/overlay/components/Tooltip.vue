<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  MOUSE_STILL_FOR_MS,
  MOUSE_WAKEUP_DISTANCE,
  EDGE_PADDING,
} from "../config.js";

import {
  onMouseStill,
  onMouseWakeup,
  setMouseSleepPosition,
} from "../lib/mouse.js";

import { modes } from "../lib/modes.js";
import { interpolateColor } from "../lib/util.js";

const props = defineProps({
  mode: {
    type: Number,
  },

  alignment: {
    type: String,
  },

  components: {
    type: Array,
  },

  debug: {
    type: Boolean,
    default: false,
  },
});

const isTooltipActive = ref(false);
const tooltipNode = ref(null);
const tooltipWidth = ref(0);
const tooltipHeight = ref(0);
const currentScanId = ref(0);
const isLoading = ref(false);
const errorMessage = ref(null);
const koreanItemName = ref("");
const koreanLines = ref([]);
const itemRarity = ref("Common");
const reverseAttributes = ref({});
const reverseKeywords = ref({});

const windowState = ref({
  canScan: false,
  visible: false,
  focused: false,
});

const scanStartMousePos = ref({ x: 0, y: 0 });
const currentMousePos = ref({ x: 0, y: 0 });

const markerNode = ref(null);
const markerTop = ref(0);
const markerLeft = ref(0);
const markerWidth = ref(0);
const markerHeight = ref(0);
const gameBounds = ref(null);

const rarityColors = {
  Poor: "var(--dnd-poor)",
  Common: "var(--dnd-common)",
  Uncommon: "var(--dnd-uncommon)",
  Rare: "var(--dnd-rare)",
  Epic: "var(--dnd-epic)",
  Legendary: "var(--dnd-legendary)",
  Unique: "var(--dnd-unique)",
  Artifact: "#f44336",
};

const uiTranslations = {
  "The Collector": "수집가",
  Woodsman: "나무꾼",
  Treasurer: "재무관",
  Alchemist: "연금술사",
  Tailor: "재단사",
  Leathersmith: "가죽 장인",
  Armourer: "갑옷 제작자",
  Weaponsmith: "무기 제작자",
  Surgeon: "외과의",
  Santa: "산타",
  "Fortune Teller": "점쟁이",
  "Goblin Merchant": "고블린 상인",
};

const item = ref({
  attributes: {
    primary: [],
    secondary: [],
  },

  demand: null,
  quality: null,
  adventurePoints: null,
  quests: [],

  prices: {
    market: null,
    live: null,
    vendor: null,
    density: null,
  },
});

const primary = computed(() =>
  item.value.attributes.primary.filter(
    (attribute) => attribute.min !== attribute.max,
  ),
);

const shouldShowContent = computed(() => {
  return markerWidth.value > 0 && (isLoading.value || errorMessage.value !== null || isTooltipActive.value);
});

watch(
  [
    shouldShowContent,
    isLoading,
    () => item.value.prices.market,
    () => item.value.attributes.secondary.length,
    () => koreanLines.value.length,
  ],
  () => {
    nextTick(() => {
      if (tooltipNode.value) {
        const rect = tooltipNode.value.getBoundingClientRect();
        tooltipWidth.value = rect.width;
        tooltipHeight.value = rect.height;
      }
    });
  },
);

const PADDING = 10;
const tooltipPosition = computed(() => {
  if (!markerWidth.value || !tooltipWidth.value || !tooltipHeight.value) {
    return { left: 0, top: 0 };
  }

  const screenW = window.innerWidth || 1920;
  const screenH = window.innerHeight || 1080;
  const shouldPlaceLeft = markerLeft.value >= tooltipWidth.value + PADDING;

  let left = shouldPlaceLeft
    ? -(tooltipWidth.value + PADDING)
    : markerWidth.value + PADDING;

  if (markerLeft.value + left + tooltipWidth.value > screenW) {
    left = -(tooltipWidth.value + PADDING);
  }

  if (markerLeft.value + left < 0) {
    left = -markerLeft.value;
  }

  let top = (markerHeight.value / 2) - (tooltipHeight.value / 2);

  if (markerTop.value + top + tooltipHeight.value > screenH) {
    top = screenH - markerTop.value - tooltipHeight.value - PADDING;
  }

  if (markerTop.value + top < 0) {
    top = -markerTop.value + PADDING;
  }

  return { left, top };
});

electron.on("game:bounds", (bounds) => {
  gameBounds.value = bounds;
  logger.debug(`[COORDS] Game bounds received: x=${bounds.x}, y=${bounds.y}, width=${bounds.width}, height=${bounds.height}`);
});

electron.on("game:state", (state) => {
  windowState.value = state;
  logger.debug(`Window state updated: canScan=${state.canScan}, visible=${state.visible}, focused=${state.focused}`);
});

const scan = (manual = false, advanced = false) => {
  if (props.mode === modes.disabled) {
    return;
  }

  const scanId = ++currentScanId.value;
  scanStartMousePos.value = {
    x: currentMousePos.value.x,
    y: currentMousePos.value.y,
  };

  logger.debug(`Checking for tooltips (scan #${scanId})`);
  electron.send("scan", { scanId, manual, advanced });
};

onMouseStill(() => {
  switch (props.mode) {
    case modes.automatic:
      scan();
      break;

    case modes.manual:
    case modes.disabled:
      break;
  }
}, MOUSE_STILL_FOR_MS);

onMouseWakeup(() => {
  isTooltipActive.value = false;
  isLoading.value = false;
  errorMessage.value = null;
}, MOUSE_WAKEUP_DISTANCE);

electron.on("scan:start", () => {
  isLoading.value = true;
  errorMessage.value = null;
  isTooltipActive.value = false;
  markerTop.value = currentMousePos.value.y;
  markerLeft.value = currentMousePos.value.x;
  markerWidth.value = 1;
  markerHeight.value = 1;
});

electron.on("clear", (data) => {
  if (data?.scanId && data.scanId !== currentScanId.value) {
    logger.debug(`Ignoring stale clear event (scanId ${data.scanId} vs current ${currentScanId.value})`);
    return;
  }

  isTooltipActive.value = false;
  isLoading.value = false;
  errorMessage.value = null;
});

electron.on("scan:finish", () => {
  setMouseSleepPosition();
});

electron.on("manual:scan", () => {
  if (props.mode === modes.disabled) {
    electron.send("manual:scan-disabled");
    return;
  }

  scan(true);
});

electron.on("manual:scan:advanced", () => {
  if (props.mode === modes.disabled) {
    electron.send("manual:scan-disabled");
    return;
  }

  scan(true, true);
});

onMounted(() => {
  logger.info("Tooltip mounted");

  window.addEventListener("mousemove", (event) => {
    currentMousePos.value = {
      x: event.clientX,
      y: event.clientY,
    };
  });

  electron.on("hover:preview", async (data) => {
    if (data.scanId !== currentScanId.value) {
      return;
    }

    applyKoreanMetadata(data);
    resetItemStats();
    positionMarker(data);
    isLoading.value = true;
    errorMessage.value = null;
    isTooltipActive.value = true;
    setMouseSleepPosition();
  });

  electron.on("hover:item", async (data) => {
    if (data.scanId !== currentScanId.value) {
      logger.debug(`Ignoring stale scan result (scanId ${data.scanId} vs current ${currentScanId.value})`);
      return;
    }

    isLoading.value = false;
    errorMessage.value = null;
    isTooltipActive.value = false;

    await nextTick();

    applyKoreanMetadata(data);

    const pricing = data.pricing || {};
    item.value.prices.market = pricing.market ?? null;
    item.value.prices.density = pricing.density ?? null;
    item.value.prices.vendor = pricing.vendor ?? null;
    item.value.demand = data.demand ?? null;
    item.value.quality = data.quality ?? null;
    item.value.adventurePoints = data.adventure_points ?? null;
    item.value.quests = data.quests || [];
    item.value.attributes.primary = data.item?.primary || [];
    item.value.attributes.secondary = data.item?.secondary || [];

    positionMarker(data);
    setMouseSleepPosition();
    isTooltipActive.value = true;
  });

  electron.on("hover:error", async (data) => {
    if (data.scanId !== currentScanId.value) {
      logger.debug(`Ignoring stale error (scanId ${data.scanId} vs current ${currentScanId.value})`);
      return;
    }

    isLoading.value = false;
    isTooltipActive.value = false;
    applyKoreanMetadata(data);
    errorMessage.value = data.message || "알 수 없는 오류가 발생했습니다";
    positionMarker(data);
    setMouseSleepPosition();
  });

  if (props.alignment === "attached") {
    let previousMousePosition = null;

    window.addEventListener("mousemove", (event) => {
      const currentMousePosition = {
        x: event.clientX,
        y: event.clientY,
      };

      if (previousMousePosition) {
        markerLeft.value += currentMousePosition.x - previousMousePosition.x;
        markerTop.value += currentMousePosition.y - previousMousePosition.y;
      }

      previousMousePosition = currentMousePosition;
    });
  }
});

onBeforeUnmount(() => {
  // Electron event cleanup follows the existing app pattern.
});

function applyKoreanMetadata(data) {
  if (data.korean_item_name) koreanItemName.value = data.korean_item_name;
  if (data.rarity) itemRarity.value = data.rarity;
  if (data.display_lines) koreanLines.value = data.display_lines;
  if (data.reverse_attributes) reverseAttributes.value = data.reverse_attributes;
  if (data.reverse_keywords) reverseKeywords.value = data.reverse_keywords;
}

function resetItemStats() {
  item.value.prices.market = null;
  item.value.prices.density = null;
  item.value.prices.vendor = null;
  item.value.demand = null;
  item.value.quality = null;
  item.value.adventurePoints = null;
  item.value.quests = [];
  item.value.attributes.primary = [];
  item.value.attributes.secondary = [];
}

function positionMarker(data) {
  const mouseDeltaX = currentMousePos.value.x - scanStartMousePos.value.x;
  const mouseDeltaY = currentMousePos.value.y - scanStartMousePos.value.y;

  if (props.alignment === "attached") {
    markerTop.value = (data.y || 0) + mouseDeltaY;
    markerLeft.value = (data.x || 0) + mouseDeltaX;
    markerWidth.value = data.width || 100;
    markerHeight.value = data.height || 50;
    return;
  }

  const bounds = gameBounds.value || {
    width: window.innerWidth,
    height: window.innerHeight,
  };

  switch (props.alignment) {
    case "top-right":
      markerTop.value = EDGE_PADDING;
      markerLeft.value = bounds.width - EDGE_PADDING;
      break;

    case "top-left":
      markerTop.value = EDGE_PADDING;
      markerLeft.value = EDGE_PADDING;
      break;

    case "bottom-right":
      markerTop.value = bounds.height - EDGE_PADDING;
      markerLeft.value = bounds.width - EDGE_PADDING;
      break;

    case "bottom-left":
      markerTop.value = bounds.height - EDGE_PADDING;
      markerLeft.value = EDGE_PADDING;
      break;
  }
}

function toKorean(englishName) {
  return reverseAttributes.value[englishName] || reverseKeywords.value[englishName] || uiTranslations[englishName] || englishName;
}

function getRarityColor() {
  return rarityColors[itemRarity.value] || "inherit";
}

function getGradeColor(grade) {
  const colors = {
    S: "var(--dnd-unique)",
    A: "var(--dnd-legendary)",
    B: "var(--dnd-epic)",
    C: "var(--dnd-rare)",
    D: "var(--dnd-uncommon)",
    F: "var(--dnd-common)",
  };

  return colors[grade] || "inherit";
}
</script>

<template>
  <div
    ref="markerNode"
    class="absolute"
    :style="{
      transform: `translate(${markerLeft}px, ${markerTop}px)`,
    }"
  >
    <div
      v-if="markerWidth > 0"
      id="marker"
      :class="{ 'border-2 border-green-500': props.debug }"
      :style="{
        width: `${markerWidth}px`,
        height: `${markerHeight}px`,
      }"
    ></div>

    <transition
      enter-active-class="transition-opacity duration-200 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="shouldShowContent"
        ref="tooltipNode"
        class="absolute"
        :class="{ 'border-2 border-yellow-500': props.debug }"
        :style="{
          left: `${tooltipPosition.left}px`,
          top: `${tooltipPosition.top}px`,
        }"
      >
        <div v-if="isLoading && !isTooltipActive" id="tooltip">
          <div class="tooltip-overlay"></div>
          <div class="tooltip-content">
            <div class="spinner-wrapper">
              <img src="@assets/images/Loading_Img.png" alt="검색 중" class="spinner-image" />
              <div class="spinner-text">검색 중...</div>
            </div>
          </div>
        </div>

        <div v-else-if="errorMessage !== null" id="tooltip">
          <div class="tooltip-overlay"></div>
          <div class="tooltip-content">
            <div class="error-title-wrapper">
              <span class="error-icon">!</span>
              <span>오류</span>
            </div>
            <div class="tooltip-body">
              <div class="error-message">{{ errorMessage }}</div>
              <section v-if="koreanItemName || koreanLines.length" class="error-debug">
                <div v-if="koreanItemName" class="debug-row">
                  <span>인식 이름</span>
                  <strong>{{ koreanItemName }}</strong>
                </div>
                <div v-if="itemRarity" class="debug-row">
                  <span>추정 등급</span>
                  <strong :style="{ color: getRarityColor() }">{{ itemRarity }}</strong>
                </div>
                <div v-if="koreanLines.length" class="debug-lines">
                  <div class="debug-label">OCR 원문</div>
                  <div v-for="line in koreanLines.slice(0, 8)" class="debug-line">
                    {{ line }}
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>

        <div v-else-if="isTooltipActive" id="tooltip">
          <div class="tooltip-overlay"></div>
          <div class="tooltip-content">
            <div
              class="tooltip-title"
              v-if="props.components.includes('header')"
              :style="{ color: koreanItemName ? getRarityColor() : 'inherit' }"
            >
              <span v-if="koreanItemName">{{ koreanItemName }}</span>
              <span v-else>아이템 통계</span>
            </div>

            <div
              class="tooltip-body"
              :class="{ 'mt-3': !props.components.includes('header') }"
            >
              <section v-if="isLoading && koreanLines.length" class="korean-preview">
                <div v-for="line in koreanLines.slice(1, 7)" class="preview-line">
                  {{ line }}
                </div>
                <div class="tooltip-separator"></div>
              </section>

              <section
                v-if="!isLoading && props.components.includes('primary') && primary.length"
              >
                <div
                  v-for="attribute in primary"
                  class="[&:not(:last-child)]:pb-2"
                >
                  <span v-if="attribute.min !== attribute.max">
                    {{ toKorean(attribute.display) }} {{ attribute.min }} -
                    {{ attribute.max }}
                  </span>
                </div>
                <div class="tooltip-separator"></div>
              </section>

              <section
                v-if="
                  !isLoading &&
                  props.components.includes('secondary') &&
                  item.attributes.secondary.length
                "
              >
                <div
                  v-for="attribute in item.attributes.secondary"
                  class="[&:not(:last-child)]:pb-2"
                >
                  <span class="tooltip-attribute text-nowrap">
                    <span>
                      {{
                        (attribute.value > 0
                          ? '+'
                          : attribute.value < 0
                            ? '-'
                            : '') +
                        attribute.value +
                        (attribute.is_percentage ? '%' : '')
                      }}
                    </span>
                    <span>{{ toKorean(attribute.display) }}</span>
                  </span>

                  <div class="text-base">
                    ({{ attribute.min }} - {{ attribute.max }}) (<span
                      :style="`color: ${getGradeColor(attribute.grade)}`"
                      >{{ attribute.grade }}</span
                    >)
                  </div>
                </div>
                <div class="tooltip-separator"></div>
              </section>

              <section
                v-if="
                  !isLoading &&
                  props.components.includes('details') &&
                  (item.quality ||
                    item.relativeQuality ||
                    item.demand ||
                    item.numSimilarSoldRecently)
                "
              >
                <div class="tooltip-stats">
                  <div v-if="item.demand" class="tooltip-stat">
                    <span>수요:</span>
                    <span :style="{ color: interpolateColor(item.demand, 10) }">
                      {{ item.demand }} / 10
                    </span>
                  </div>
                  <div v-if="item.adventurePoints" class="tooltip-stat">
                    <span>모험 포인트:</span>
                    <span>{{ item.adventurePoints }}</span>
                  </div>
                </div>
                <div class="tooltip-separator"></div>
              </section>

              <section
                v-if="
                  !isLoading &&
                  props.components.includes('quests') &&
                  item.quests.length
                "
              >
                <div class="text-lg">
                  <span style="color: var(--dnd-feather)">퀘스트 아이템</span>

                  <div v-for="quest in item.quests" class="text-nowrap">
                    <span style="color: var(--dnd-aqua)">
                      {{ toKorean(quest.merchant) }}
                      <span style="color: var(--dnd-dust)">{{ quest.title }}:</span>
                    </span>
                    <span class="ml-2">{{ quest.count }}x</span>
                  </div>
                </div>
                <div class="tooltip-separator"></div>
              </section>

              <div class="mx-auto min-w-40" v-if="props.components.includes('pricing')">
                <div v-if="isLoading" class="pricing-loading">
                  <img src="@assets/images/Loading_Img.png" alt="가격 조회 중" class="pricing-spinner" />
                  <span class="pricing-loading-text">가격 조회 중...</span>
                </div>
                <template v-else>
                  <div class="flex items-center justify-center" v-if="item.prices.market !== null">
                    <span>시장가:</span>
                    <span class="gold ml-2">{{ item.prices.market }}</span>
                  </div>
                  <div class="flex items-center justify-center" v-if="item.prices.vendor !== null">
                    <span>상점가:</span>
                    <span class="gold ml-2">{{ item.prices.vendor }}</span>
                  </div>
                  <div class="flex items-center justify-center" v-if="item.prices.density !== null">
                    <span>칸당 가치:</span>
                    <span class="gold ml-2">{{ item.prices.density }}</span>
                  </div>
                </template>
              </div>

              <div class="tooltip-separator"></div>

              <div class="text-xs" style="color: var(--dnd-oak)">
                Powered by DarkerDB.com
              </div>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.error-title-wrapper {
  @apply py-3 text-[1.65rem] flex items-center justify-center gap-2;
  color: #ef4444;
}

.error-title-wrapper:after {
  @apply content-[''] block w-full h-1 mt-2 mb-1 absolute left-0;
  background-image: url('@assets/images/Tooltip_SeparatorThick.png');
  background-size: contain;
  background-position: center;
}

.error-icon {
  @apply inline-flex items-center justify-center rounded-full border border-red-400;
  width: 1.4rem;
  height: 1.4rem;
  font-size: 1rem;
}

.error-message {
  @apply text-[1.15rem] text-center;
  color: #fecaca;
  line-height: 1.5;
}

.error-debug {
  @apply mt-4 pt-3 text-left;
  border-top: 1px solid rgba(239, 68, 68, 0.45);
  color: #fecaca;
}

.debug-row {
  @apply flex justify-between gap-4 pb-1 text-[0.95rem];
}

.debug-row span,
.debug-label {
  color: #fca5a5;
}

.debug-lines {
  @apply mt-2;
}

.debug-label {
  @apply pb-1 text-[0.9rem];
}

.debug-line {
  @apply pb-1 text-[0.9rem];
  color: #fee2e2;
  line-height: 1.35;
  word-break: keep-all;
  overflow-wrap: anywhere;
}

.spinner-wrapper {
  @apply flex flex-col items-center justify-center gap-2 py-4 px-6;
}

.spinner-image,
.pricing-spinner {
  animation: spin 1s linear infinite;
}

.spinner-image {
  width: 40px;
  height: 40px;
}

.spinner-text,
.pricing-loading-text,
.preview-line {
  color: var(--dnd-feather);
}

.pricing-loading {
  @apply flex items-center justify-center gap-2 py-1;
}

.pricing-spinner {
  width: 20px;
  height: 20px;
}

.preview-line {
  @apply text-[1.05rem] pb-1;
  line-height: 1.45;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
