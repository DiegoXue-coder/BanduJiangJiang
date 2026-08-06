// 多机联调：EXPO_PUBLIC_ENGINEER_LABEL在mobile/.env.local里各机器自己设
// （该文件已在.gitignore的.env*.local规则里，两台机器互不覆盖）。
// 设了这个变量时，把它拼进App显示名字——这样Expo Go的项目列表/最近打开
// 里，两台机器起的服务器名字就长得不一样（"沉光共读（1号工程师）" vs
// "沉光共读（2号工程师）"），打开前就能选对，不用打开了才靠App内角标确认。
// 不设这个变量时（所有正式EAS构建都不设）name完全不变。
module.exports = ({ config }) => {
  const label = process.env.EXPO_PUBLIC_ENGINEER_LABEL;
  if (label) {
    config.name = `${config.name}（${label}）`;
  }
  return config;
};
