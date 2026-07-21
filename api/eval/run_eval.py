# -*- coding: utf-8 -*-
"""苏格拉底/讲解提示词的离线回归测试。

范围声明：只服务于 `api/main.py` 里 `_build_ask_messages` 这一个具体场景（划线
苏格拉底提问 + 直接讲解两种模式），不是通用评测平台。语音听感/交互衔接顺不顺
不在这里测，那部分继续靠真机人测。

用法：
    cd api && python eval/run_eval.py            # 跑 cases.json 里全部用例
    cd api && python eval/run_eval.py round2      # 只跑 id 里含 "round2" 的用例

原理：
1. 导入 main.py，直接复用 `_build_ask_messages()` 组装跟线上完全一致的
   messages——不是另抄一份提示词，改了 main.py 这套测试就会跟着测到新版本，
   不会出现测试脚本测的是过时逻辑这种坑。
2. 对每条用例实测调用 DeepSeek，记录耗时（对应"响应延迟"这一层）。
3. 跑几条不花 token 的确定性检查（对应"格式对不对"，比如有没有残留方括号、
   该不该有问号、前缀对不对）。
4. 把最终回复 + 用例里人话写的 `expect` 交给同一个模型当裁判打分（对应"内容
   质量"这一层），裁判只根据 expect 判断，不套用自己的其他标准。
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as app  # noqa: E402

CASES_FILE = Path(__file__).with_name("cases.json")
MODEL = "deepseek-v4-flash"


def load_cases():
    return json.loads(CASES_FILE.read_text(encoding="utf-8"))


def call_model(ds, messages, max_tokens, temperature):
    t0 = time.perf_counter()
    resp = ds.chat.completions.create(
        model=MODEL,
        max_tokens=max_tokens,
        temperature=temperature,
        messages=messages,
        extra_body={"thinking": {"type": "disabled"}},
    )
    elapsed = time.perf_counter() - t0
    return resp.choices[0].message.content, elapsed


def deterministic_checks(finalized: str, round_num: int) -> list[str]:
    """不花 token 的格式检查，返回违规原因列表，空列表表示都通过。"""
    problems = []
    if "[" in finalized or "]" in finalized:
        problems.append("回复里残留了字面方括号（提示词格式说明被抄进回复了）")

    is_complete_answer = finalized.startswith("你已经推导出来了——") or finalized.startswith("先说清楚——")
    if round_num >= app.SOCR_MAX_ROUNDS:
        if not finalized.startswith("你已经推导出来了——"):
            problems.append(f"round_num={round_num} 已达上限，必须以「你已经推导出来了——」开头")
    elif not is_complete_answer and not (finalized.endswith("？") or finalized.endswith("?")):
        problems.append("既不是「先说清楚——/你已经推导出来了——」开头的完整解释，结尾也没有问号，像是被截断或格式不对")
    return problems


def judge(ds, case, finalized_text) -> tuple[bool, str]:
    # 实测发现裁判会出现"结论跟回复原文对不上"的假阴性（比如回复明明先说了
    # "你说得对"，裁判却断言"没有先承认"）——加一条"判 FAIL 必须逐字引用回复
    # 里的依据"的要求，逼它把推理落到实处，减少凭空给结论的情况。
    judge_system = (
        "你是一个严格的评审，负责判断一段AI回复是否符合给定的期望描述。"
        "只根据下面提供的期望描述判断，不要套用你自己对\"好回复\"的其他标准。"
        "如果判定不通过（pass=false），reason里必须原样引用AI回复中具体是哪一句"
        "话不符合期望，不能只给抽象结论；如果在AI回复里找不到能支撑\"不通过\"的"
        "具体原文依据，就应该判 pass=true。"
        "只输出一个JSON对象，格式：{\"pass\": true或false, \"reason\": \"一句话理由，"
        "不通过时必须包含引用的原文\"}，不要输出其他任何内容。"
    )
    user_content = (
        f"对话历史：{json.dumps(case.get('history', []), ensure_ascii=False)}\n"
        f"用户当前输入：{case['question']}\n"
        f"AI最新回复：{finalized_text}\n"
        f"期望：{case['expect']}"
    )
    resp = ds.chat.completions.create(
        model=MODEL,
        max_tokens=150,
        temperature=0,
        messages=[
            {"role": "system", "content": judge_system},
            {"role": "user", "content": user_content},
        ],
        extra_body={"thinking": {"type": "disabled"}},
    )
    raw = resp.choices[0].message.content.strip()
    try:
        if raw.startswith("```"):
            raw = raw.strip("`")
            if raw.startswith("json"):
                raw = raw[4:]
        parsed = json.loads(raw)
        return bool(parsed["pass"]), str(parsed.get("reason", ""))
    except Exception:
        return False, f"裁判输出解析失败：{raw[:200]}"


def run(filter_substr=None):
    ds = app._make_ds(app.os.environ.get("DEEPSEEK_API_KEY", ""))
    if not ds:
        print("缺少 DEEPSEEK_API_KEY，检查 api/.env")
        sys.exit(1)

    cases = load_cases()
    if filter_substr:
        cases = [c for c in cases if filter_substr in c["id"]]
    if not cases:
        print(f"没有匹配 \"{filter_substr}\" 的用例")
        return

    results = []
    for case in cases:
        history = case.get("history", [])
        round_num = len(history) // 2 + 1
        question = case["question"]
        messages, max_tokens, temperature = app._build_ask_messages(
            case["style"], round_num, history, question, question, case.get("selection"),
        )
        raw, latency = call_model(ds, messages, max_tokens, temperature)
        finalized = app._finalize_socratic_text(raw, case["style"], round_num)

        det_problems = deterministic_checks(finalized, round_num) if case["style"] == "socratic" else []
        judge_pass, judge_reason = judge(ds, case, finalized)

        results.append({
            "id": case["id"],
            "passed": judge_pass and not det_problems,
            "latency": latency,
            "finalized": finalized,
            "det_problems": det_problems,
            "judge_reason": judge_reason,
        })

    print("=" * 70)
    for r in results:
        status = "PASS" if r["passed"] else "FAIL"
        print(f"[{status}] {r['id']}  ({r['latency']:.2f}s)")
        print(f"  回复: {r['finalized']}")
        if r["det_problems"]:
            print(f"  格式问题: {'; '.join(r['det_problems'])}")
        print(f"  裁判: {r['judge_reason']}")
        print()

    n_pass = sum(r["passed"] for r in results)
    latencies = [r["latency"] for r in results]
    print("=" * 70)
    print(f"通过 {n_pass}/{len(results)}")
    if latencies:
        print(f"延迟：avg={sum(latencies)/len(latencies):.2f}s  "
              f"max={max(latencies):.2f}s  min={min(latencies):.2f}s")

    sys.exit(0 if n_pass == len(results) else 1)


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else None)
