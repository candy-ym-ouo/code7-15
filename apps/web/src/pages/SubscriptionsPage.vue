<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import type { CategoryKey } from "@map/shared/contracts";
import LocationPicker from "../components/LocationPicker.vue";
import { apiFetch } from "../lib/api";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();

type Category = { key: CategoryKey; name: string };
type Frequency = "instant" | "daily" | "weekly";
type Subscription = {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  radiusM: number;
  categoryKeys: CategoryKey[];
  frequency: Frequency;
  isActive: boolean;
  createdAt: string;
};

const categories = ref<Category[]>([]);
const items = ref<Subscription[]>([]);
const error = ref("");
const success = ref("");
const busy = ref(false);
const editingId = ref<string | null>(null);

const radiusOptions = [200, 500, 1000, 2000, 5000, 10000, 20000];
const frequencyLabels: Record<Frequency, string> = {
  instant: "即时通知",
  daily: "每日摘要",
  weekly: "每周摘要"
};

const form = reactive({
  name: "",
  longitude: 116.397,
  latitude: 39.908,
  radiusM: 1000,
  categoryKeys: [] as CategoryKey[],
  frequency: "instant" as Frequency,
  isActive: true
});

const location = computed({
  get: (): [number, number] => [form.longitude, form.latitude],
  set: (value: [number, number]) => { form.longitude = value[0]; form.latitude = value[1]; }
});

function categoryName(key: string) {
  return categories.value.find((item) => item.key === key)?.name ?? key;
}

function formatRadius(meters: number) {
  return meters >= 1000 ? `${meters / 1000} 公里` : `${meters} 米`;
}

function toggleCategory(key: CategoryKey) {
  const index = form.categoryKeys.indexOf(key);
  if (index >= 0) form.categoryKeys.splice(index, 1);
  else form.categoryKeys.push(key);
}

function resetForm() {
  editingId.value = null;
  form.name = "";
  form.radiusM = 1000;
  form.categoryKeys = [];
  form.frequency = "instant";
  form.isActive = true;
}

async function load() {
  try {
    const [categoryRows, subscriptions] = await Promise.all([
      apiFetch<Category[]>("/categories"),
      apiFetch<Subscription[]>("/me/subscriptions")
    ]);
    categories.value = categoryRows;
    items.value = subscriptions;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载订阅失败";
  }
}

function edit(item: Subscription) {
  editingId.value = item.id;
  form.name = item.name;
  form.longitude = item.longitude;
  form.latitude = item.latitude;
  form.radiusM = item.radiusM;
  form.categoryKeys = [...item.categoryKeys];
  form.frequency = item.frequency;
  form.isActive = item.isActive;
  error.value = "";
  success.value = "";
}

async function save() {
  error.value = "";
  success.value = "";
  if (!form.name.trim()) {
    error.value = "请填写订阅名称。";
    return;
  }
  busy.value = true;
  const payload = {
    name: form.name.trim(),
    longitude: Number(form.longitude),
    latitude: Number(form.latitude),
    radiusM: Number(form.radiusM),
    categoryKeys: form.categoryKeys,
    frequency: form.frequency,
    isActive: form.isActive
  };
  try {
    if (editingId.value) {
      const updated = await apiFetch<Subscription>(`/me/subscriptions/${editingId.value}`, { method: "PATCH", body: payload });
      items.value = items.value.map((item) => (item.id === updated.id ? updated : item));
      success.value = "订阅已保存。范围变化已触发重算，已通知过的地点不会重复提醒。";
    } else {
      const created = await apiFetch<Subscription>("/me/subscriptions", { method: "POST", body: payload });
      items.value = [created, ...items.value];
      success.value = "订阅已创建，已对范围内的已发布地点完成匹配。";
    }
    resetForm();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存订阅失败";
  } finally {
    busy.value = false;
  }
}

async function remove(item: Subscription) {
  if (!window.confirm(`确定删除订阅「${item.name}」吗？`)) return;
  error.value = "";
  try {
    await apiFetch(`/me/subscriptions/${item.id}`, { method: "DELETE" });
    items.value = items.value.filter((entry) => entry.id !== item.id);
    if (editingId.value === item.id) resetForm();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "删除订阅失败";
  }
}

onMounted(load);
</script>

<template>
  <section>
    <div class="page-heading">
      <div>
        <h1>地理围栏订阅</h1>
        <p>保存关注的区域、分类和提醒频率。范围内有新的已发布地点时通知你；修改范围会自动重算，同一地点不会重复通知。</p>
      </div>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="success" class="success-box">{{ success }}</p>
    <p v-if="!auth.isVerified" class="notice-box">验证邮箱后才能创建或修改订阅。</p>

    <div v-if="auth.isVerified" class="card">
      <div class="card-body">
        <h2>{{ editingId ? "编辑订阅" : "新建订阅" }}</h2>
        <form @submit.prevent="save">
          <div class="field">
            <label for="sub-name">名称</label>
            <input id="sub-name" v-model="form.name" maxlength="60" placeholder="例如：公司附近、家门口公园" />
          </div>
          <div class="field">
            <label>中心位置（点击地图选择）</label>
            <LocationPicker v-model="location" />
            <small class="muted">经度 {{ form.longitude.toFixed(5) }}，纬度 {{ form.latitude.toFixed(5) }}</small>
          </div>
          <div class="field">
            <label for="sub-radius">半径</label>
            <select id="sub-radius" v-model.number="form.radiusM">
              <option v-for="option in radiusOptions" :key="option" :value="option">{{ formatRadius(option) }}</option>
            </select>
          </div>
          <div class="field">
            <label>分类（不勾选表示全部）</label>
            <div class="inline">
              <label v-for="category in categories" :key="category.key" class="inline">
                <input
                  type="checkbox"
                  :checked="form.categoryKeys.includes(category.key)"
                  @change="toggleCategory(category.key)"
                />
                {{ category.name }}
              </label>
            </div>
          </div>
          <div class="field">
            <label for="sub-frequency">提醒频率</label>
            <select id="sub-frequency" v-model="form.frequency">
              <option v-for="(label, value) in frequencyLabels" :key="value" :value="value">{{ label }}</option>
            </select>
          </div>
          <div v-if="editingId" class="field">
            <label class="inline">
              <input v-model="form.isActive" type="checkbox" />
              启用订阅（停用期间不会匹配也不会通知）
            </label>
          </div>
          <div class="inline">
            <button class="button" type="submit" :disabled="busy">{{ busy ? "保存中…" : editingId ? "保存修改" : "创建订阅" }}</button>
            <button v-if="editingId" class="button ghost" type="button" @click="resetForm">取消编辑</button>
          </div>
        </form>
      </div>
    </div>

    <div v-if="!items.length" class="card empty">还没有订阅。创建后，范围内新发布的地点会按你选择的频率通知你。</div>
    <div v-else class="stack">
      <article v-for="item in items" :key="item.id" class="card">
        <div class="card-body">
          <div class="inline" style="justify-content: space-between">
            <strong>{{ item.name }}</strong>
            <small class="muted">{{ item.isActive ? "启用中" : "已停用" }}</small>
          </div>
          <p class="muted">
            半径 {{ formatRadius(item.radiusM) }} ·
            {{ item.categoryKeys.length ? item.categoryKeys.map(categoryName).join("、") : "全部分类" }} ·
            {{ frequencyLabels[item.frequency] }}
          </p>
          <div class="inline">
            <button class="button secondary small" type="button" @click="edit(item)">编辑</button>
            <button class="button ghost small" type="button" @click="remove(item)">删除</button>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
