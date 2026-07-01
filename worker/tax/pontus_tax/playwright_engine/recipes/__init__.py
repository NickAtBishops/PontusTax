"""Recipe registry.

Add a new vendor family by writing a `Recipe` subclass in this folder
and importing it below; the router uses `ALL_RECIPES` in declaration
order and picks the FIRST whose `matches(url)` returns True.

Order matters when patterns overlap: put more-specific patterns first.
"""

from __future__ import annotations

from .base import FetchResult, Recipe, RecipeError, RowContext
from .grant_street import GrantStreetRecipe

ALL_RECIPES: list[type[Recipe]] = [
    GrantStreetRecipe,
    # Future recipes land here. Examples to add next, in
    # decreasing portfolio coverage:
    #   PublicAccessNowRecipe   ( *.publicaccessnow.com )
    #   PtaxWebRecipe           ( ptaxweb / Pacific Blue family )
    #   TylerRecipe             ( Tyler Technologies; varied hosts )
    #   BeaconRecipe            ( beacon.schneidercorp.com )
]


def match(url: str | None) -> type[Recipe] | None:
    """Return the first recipe class whose URL pattern matches, or None."""
    if not url:
        return None
    for cls in ALL_RECIPES:
        if cls.matches(url):
            return cls
    return None


__all__ = [
    "ALL_RECIPES",
    "FetchResult",
    "Recipe",
    "RecipeError",
    "RowContext",
    "match",
]
