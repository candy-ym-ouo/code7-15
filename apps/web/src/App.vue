<script setup lang="ts">
import { useRouter } from "vue-router";
import { useAuthStore } from "./stores/auth";

const auth = useAuthStore();
const router = useRouter();

async function logout() {
  await auth.logout();
  await router.push("/map");
}
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <RouterLink class="brand" to="/map">
        <span class="brand-mark">公</span>
        <span>
          <strong>公共空间细节地图</strong>
          <small>看见一个地点是否真正好用</small>
        </span>
      </RouterLink>
      <nav class="main-nav" aria-label="主导航">
        <RouterLink to="/map">地图</RouterLink>
        <RouterLink v-if="auth.isAuthenticated && auth.isVerified" to="/submit">投稿</RouterLink>
        <RouterLink v-if="auth.isAuthenticated" to="/me/contributions">我的内容</RouterLink>
        <RouterLink v-if="auth.isAuthenticated" to="/me/comments">评论</RouterLink>
        <RouterLink v-if="auth.isAuthenticated" to="/me/notifications">通知</RouterLink>
        <RouterLink v-if="auth.isAuthenticated" to="/me/subscriptions">订阅</RouterLink>
        <RouterLink v-if="auth.canModerate" to="/moderation">审核</RouterLink>
      </nav>
      <div class="account-nav">
        <template v-if="auth.user">
          <RouterLink class="user-chip" to="/me/settings">{{ auth.user.displayName }}</RouterLink>
          <button class="button ghost small" type="button" @click="logout">退出</button>
        </template>
        <template v-else>
          <RouterLink class="button ghost small" to="/login">登录</RouterLink>
          <RouterLink class="button small" to="/register">注册</RouterLink>
        </template>
      </div>
    </header>
    <main class="page-shell">
      <RouterView />
    </main>
  </div>
</template>
