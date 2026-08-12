import React, { createContext, useCallback, useContext, useState } from 'react';

// 续二十三访客模式：全局context，暴露"当前是不是登录状态"+一个requireAuth
// 触发器。三个约定的触发点（点"我的"/点导入/点AI相关入口）遇到访客态，
// 调用requireAuth(reason)弹出注册引导——不需要每个屏幕自己各写一套弹窗
// 逻辑，也不需要给深层屏幕（ReaderScreen/ListenScreen分别挂在不同Stack
// 下面）透传navigation去跳转到某个LoginScreen路由，改成App.js顶层挂一个
// 全局Modal（见components/GuestPromptModal.js），任何屏幕拿到这个context
// 就能弹。

const AuthGateContext = createContext(null);

// 触发点对应的提示文案——具体UI（弹层视觉、动效）是1号的活，这里只给
// 一版能用、语义正确的文案，不是最终视觉稿。
export const GUEST_PROMPT_REASONS = {
  profile: '登录后可以查看和管理你的账号',
  import: '登录后才能导入自己的书',
  ai: '登录后才能向AI提问、保存划线',
  // "划线复盘"tab本身不在决策层列出的三个触发点里，但同样是账号数据、
  // 访客必然看不到，复用同一套requireAuth机制单独给一条更贴切的文案。
  review: '登录后可以看到你的划线、问答记录和知识图谱',
};

export function AuthGateProvider({ loggedIn, onLoggedIn, children }) {
  const [reason, setReason] = useState(null); // null | 'profile' | 'import' | 'ai'

  // 访客调用时弹提示、返回false（调用方据此中断后续动作）；已登录用户
  // 调用时什么都不做、直接返回true放行——所有触发点统一用
  // `if (!requireAuth('xxx')) return;` 这一行守卫，不用在每处自己判断
  // loggedIn。
  const requireAuth = useCallback((reasonKey) => {
    if (loggedIn) return true;
    setReason(reasonKey);
    return false;
  }, [loggedIn]);

  const dismiss = useCallback(() => setReason(null), []);

  // 弹层里登录/注册成功后：既要把App.js顶层的loggedIn状态翻过来（触发
  // 全App从访客态切到真实登录态的重渲染），也要把这次的提示弹层收起来。
  const handleLoggedIn = useCallback(() => {
    onLoggedIn();
    setReason(null);
  }, [onLoggedIn]);

  return (
    <AuthGateContext.Provider value={{ loggedIn, requireAuth, reason, dismiss, handleLoggedIn }}>
      {children}
    </AuthGateContext.Provider>
  );
}

export function useAuthGate() {
  const ctx = useContext(AuthGateContext);
  if (!ctx) throw new Error('useAuthGate must be used within AuthGateProvider');
  return ctx;
}
