"""API 富集层:对已装配答复做非事实性提炼(TL;DR 综述等)。不在路由/域内,默认零 LLM。"""

from query.enrich.summary import summarize_answer

__all__ = ["summarize_answer"]
