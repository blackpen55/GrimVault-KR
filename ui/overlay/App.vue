<script setup>
import { onMounted, ref, watch } from "vue";
import Tooltip from "./components/Tooltip.vue";
import Popup from "./components/Popup.vue";
import { modes } from "./lib/modes.js";

const mode = ref(modes.automatic);
const popup = ref(false);
const settings = ref(null);
const isDebugging = ref(false);

let popupTimeout;

watch (mode, () => {
  popup.value = true;

  if (popupTimeout) {
    clearTimeout(popupTimeout);
  }

  popupTimeout = setTimeout(() => {
    popup.value = false;
  }, 750);
});

electron.on ('settings', (config) => {
  logger.debug (`Client received settings: ${JSON.stringify(config, null, 4)}`);
  settings.value = config;
  mode.value = modes [config.general.default_mode];
  document.documentElement.style.setProperty('--scale', config.general.scale);
});

electron.on ('manual:toggle', () => {
  switch (mode.value) {
    case modes.automatic:
      mode.value = modes.manual;
      break;

    case modes.manual:
      mode.value = modes.disabled;
      break;

    case modes.disabled:
      mode.value = modes.automatic;
      break;
  }

  logger.debug (`Changed mode to: ${mode.value}`);
});

electron.on("manual:debugger", () => {
  isDebugging.value = !isDebugging.value;
});

onMounted(() => {
  electron.send("ready");
});
</script>

<template>
  <teleport to="body">
    <div
      v-if="isDebugging"
      class="absolute bottom-0 left-0 right-0 top-0 border border-2 border-yellow-500 bg-red-500/5"
    ></div>
  </teleport>

  <div :class="{ debugging: isDebugging }" v-if="settings">
    <Tooltip
      :mode="mode"
      :alignment="settings.general.alignment"
      :components="settings.general.components"
      :debug="isDebugging"
    />

    <transition
      enter-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0 scale-90"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-200"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <Popup v-if="popup">
        <div>
          <span v-if="mode === modes.automatic"
            >GrimVault
            <span class="font-bold underline">자동 모드</span> 활성화.
            <br />
            <span class="text-base"
              >아이템 위에 마우스를 올리면 가격을 조회합니다.</span
            ></span
          >
          <span v-if="mode === modes.manual"
            >GrimVault
            <span class="font-bold underline">수동 모드</span> 활성화.
            <br />
            <span class="text-base"
              >아이템 위에서 F5를 눌러 가격을 조회합니다.</span
            ></span
          >
          <span v-if="mode === modes.disabled"
            >GrimVault <span class="font-bold underline">비활성화</span>. <br />
            <span class="text-base"
              >F6으로 다시 활성화하기 전까지 가격 조회를 하지 않습니다.</span
            ></span
          >
        </div>

        <ul class="dotted mt-3 justify-center text-sm text-gray-300">
          <li>
            <span
              :class="{ 'text-green-500 underline': mode === modes.automatic }"
              >자동</span
            >
          </li>
          <li>
            <span :class="{ 'text-green-500 underline': mode === modes.manual }"
              >수동</span
            >
          </li>
          <li>
            <span
              :class="{ 'text-green-500 underline': mode === modes.disabled }"
              >비활성</span
            >
          </li>
        </ul>
      </Popup>
    </transition>
  </div>
</template>
