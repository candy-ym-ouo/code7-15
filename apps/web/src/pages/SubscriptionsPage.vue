<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { categoryKeys, type CategoryKey, type SubscriptionFrequency } from "@map/shared/contracts";
import LocationPicker from "../components/LocationPicker.vue";
import { apiFetch } from "../lib/api";

type Category = { key: CategoryKey; name: string };
type Subscription = {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  radiusM: number;
  categoryKeys: CategoryKey[];
  frequency: SubscriptionFrequency;
  isActive: boolean;
  recomputePending: boolean;
  lastDigestAt: string | null;
  createdAt: string;
};

const frequencyLabels: Record<SubscriptionFrequency, string> = {
  instant: "即时提醒",
  daily: "每日摘要",
  weekly: "每周摘要"
};

const categories = ref<Category[]>([]);
const items = ref<Subscription[]>([]);
const error = ref("");
const success = ref("");
const busy = ref(false);
const editingId = ref<string | null>(null);

const form = reactive({
  name: "",
  longitude: 116.397,
  latitude: 39.908,
  radiusM: 2000,
  categoryKeys: [] as CategoryKey[],
  frequency: "daily" as SubscriptionFrequency
});

const location = computed({
  get: (): [number, number] => [form.longitude, form.latitude],
  set: (value: [number, number]) => { form.longitude = value[0]; form.latitude = value[1]; }
});

const categoryName = computed(() => {
  const map = new Map(categories.value.map((item) => [item.key, item.name]));
  return (key: CategoryKey) => map.get(key) ?? key;
});

function resetForm() {
  editingId.value = null;
  form.name = "";
  form.radiusM = 2000;
  form.categoryKeys = [];
  form.frequency = "daily";
}

function startEdit(item: Subscription) {
  editingId.value = item.id;
  form.name = item.name;
  form.longitude = item.longitude;
  form.latitude = item.latitude;
  form.radiusM = item.radiusM;
  form.categoryKeys = [...item.categoryKeys];
  form.frequency = item.frequency;
  success.value = "";
  error.value = "";
}

function toggleCategory(key: CategoryKey) {
  const index = form.categoryKeys.indexOf(key);
  if (index >= 0) form.categoryKeys.splice(index, 1);
  else form.categoryKeys.push(key);
}

async function load() {
  try {
    const [subscriptionList, categoryList] = await Promise.all([
      apiFetch<Subscription[]>("/subscriptions"),
      apiFetch<Category[]>("/categories")
    ]);
    items.value = subscriptionList;
    categories.value = categoryList;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载订阅失败";
  }
}

async function save() {
  busy.value = true;
  error.value = "";
  success.value = "";
  try {
    const payload = {
      name: form.name,
      longitude: form.longitude,
      latitude: form.latitude,
      radiusM: form.radiusM,
      categoryKeys: form.categoryKeys,
      frequency: form.frequency
    };
    if (editingId.value) {
      await apiFetch(`/subscriptions/${editingId.value}`, { method: "PATCH", body: payload });
      success.value = "订阅已更新，范围变化会重新匹配存量内容。";
    } else {
      await apiFetch("/subscriptions", { method: "POST", body: payload });
      success.value = "订阅已创建，正在匹配区域内已发布的内容。";
    }
    resetForm();
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存订阅失败";
  } finally {
    busy.value = false;
  }
}

async function toggleActive(item: Subscription) {
  try {
    await apiFetch(`/subscriptions/${item.id}`, { method: "PATCH", body: { isActive: !item.isActive } });
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "更新订阅状态失败";
  }
}

async function remove(item: Subscription) {
  if (!window.confirm(`确定删除订阅「${item.name}」吗？`)) return;
  try {
    await apiFetch(`/subscriptions/${item.id}`, { method: "DELETE" });
    if (editingId.value === item.id) resetForm();
    await load();
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
        <h1>区域订阅</h1>
        <p>保存关注的区域、分类和提醒频率；范围内有新的公开内容时会通知你。</p>
      </div>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="success" class="success-box">{{ success }}</p>

    <div class="grid-2">
      <div class="card"><div class="card-body">
        <h2>{{ editingId ? "编辑订阅" : "新建订阅" }}</h2>
        <form @submit.prevent="save">
          <div class="field">
            <label for="sub-name">名称</label>
            <input id="sub-name" v-model="form.name" required minlength="1" maxlength="60" placeholder="例如：家附近、公司周边" />
          </div>
          <div class="field">
            <label>中心位置（点击地图选择）</label>
            <LocationPicker v-model="location" />
            <small class="muted">{{ form.longitude.toFixed(5) }}, {{ form.latitude.toFixed(5) }}</small>
          </div>
          <div class="field">
            <label for="sub-radius">半径（米，100–50000）</label>
            <input id="sub-radius" v-model.number="form.radiusM" type="number" min="100" max="50000" step="100" required />
          </div>
          <div class="field">
            <label>分类（不选表示全部）</label>
            <div class="inline">
              <label v-for="category in categories" :key="category.key" class="muted">
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
          <div class="inline">
            <button class="button" type="submit" :disabled="busy">{{ editingId ? "保存修改" : "创建订阅" }}</button>
            <button v-if="editingId" class="button ghost" type="button" @click="resetForm">取消编辑</button>
          </div>
        </form>
      </div></div>

      <div class="stack">
        <div v-if="!items.length" class="card empty">还没有订阅。创建一个区域订阅后，范围内有新的公开内容时会通知你。</div>
        <article v-for="item in items" :key="item.id" class="card"><div class="card-body">
          <div class="inline" style="justify-content: space-between">
            <strong>{{ item.name }}</strong>
            <span class="inline">
              <span v-if="item.recomputePending" class="badge pending">同步中</span>
              <span v-if="!item.isActive" class="badge hidden">已暂停</span>
            </span>
          </div>
          <p class="muted">
            半径 {{ item.radiusM }} 米 ·
            {{ item.categoryKeys.length ? item.categoryKeys.map(categoryName).join("、") : "全部分类" }} ·
            {{ frequencyLabels[item.frequency] }}
          </p>
          <div class="inline">
            <button class="button secondary small" type="button" @click="startEdit(item)">编辑</button>
            <button class="button ghost small" type="button" @click="toggleActive(item)">{{ item.isActive ? "暂停" : "启用" }}</button>
            <button class="button danger small" type="button" @click="remove(item)">删除</button>
          </div>
        </div></article>
      </div>
    </div>
  </section>
</template>
