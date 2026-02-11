# low_cost_elm.py
import math

def est_tokens(text: str) -> int:
    return max(1, len(text) // 4)

def est_messages_tokens(messages):
    return sum(est_tokens(m.get("content", "")) for m in messages)

SUMMARIZE_SYS = (
    "Compress the content WITHOUT losing any information. "
    "Preserve facts, numbers, requirements, constraints, steps, and code. "
    "Do NOT answer the question."
)

ANSWER_SYS = (
    "Answer the user using the compressed context as if you had the full context. "
    "Do not mention summarization."
)

def run_low_cost_elm(
    call_fn,
    cheap_model,
    expensive_model,
    messages,
    user_question
):
    # 1) summarize cheaply
    summarize_prompt = "\n".join(
        f"{m['role'].upper()}: {m['content']}" for m in messages
    )

    summary = call_fn(
        cheap_model,
        [
            {"role": "system", "content": SUMMARIZE_SYS},
            {"role": "user", "content": summarize_prompt},
        ]
    )["reply"]

    # 2) answer expensively
    final = call_fn(
        expensive_model,
        [
            {"role": "system", "content": ANSWER_SYS},
            {"role": "user", "content": f"Context:\n{summary}\n\nQuestion:\n{user_question}"}
        ]
    )["reply"]

    return final
