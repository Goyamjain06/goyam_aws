"""Hindi / English formatting helpers used by the fallback replies and the agent tools."""


def hour_hi(h: int) -> str:
    h = h % 24
    h12 = h % 12 or 12
    if 4 <= h < 12:
        part = "सुबह"
    elif 12 <= h < 16:
        part = "दोपहर"
    elif 16 <= h < 19:
        part = "शाम"
    else:
        part = "रात"
    return f"{part} {h12} बजे"


def hour_en(h: int) -> str:
    h = h % 24
    return f"{h % 12 or 12} {'am' if h < 12 else 'pm'}"


def hour_label(h: int, lang: str = "hi") -> str:
    return hour_en(h) if lang == "en" else hour_hi(h)


def cig_hi(c: float) -> str:
    if c < 0.1:
        return "एक सिगरेट के दसवें हिस्से से भी कम"
    return f"लगभग {round(c, 1)} सिगरेट"


def cig_label(c: float, lang: str = "hi") -> str:
    if lang == "en":
        return "less than a tenth of a cigarette" if c < 0.1 else f"about {round(c, 1)} cigarettes"
    return cig_hi(c)
