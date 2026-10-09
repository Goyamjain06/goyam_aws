"""Small Hindi formatting helpers used by the fallback replies and the agent prompt."""


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


def cig_hi(c: float) -> str:
    if c < 0.1:
        return "एक सिगरेट के दसवें हिस्से से भी कम"
    if c < 1:
        return f"लगभग {round(c, 1)} सिगरेट"
    return f"लगभग {round(c, 1)} सिगरेट"
