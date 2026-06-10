from pontus_tax.identifiers import (
    account_matches, candidate_variants, split_accounts,
)


def test_strip_hash_and_variants():
    groups = split_accounts("#74-43-43-21-01-043-0050")
    assert len(groups) == 1
    g = groups[0]
    assert g.display == "74-43-43-21-01-043-0050"
    assert g.candidates[0] == "74-43-43-21-01-043-0050"
    assert "74434321010430050" in g.candidates


def test_florida_row4_three_accounts():
    groups = split_accounts("#T815151/#T813795/#R444958")
    assert [g.display for g in groups] == ["T815151", "T813795", "R444958"]


def test_semicolon_and_comma_split():
    groups = split_accounts("123-45; 678-90, 111-22")
    assert [g.display for g in groups] == ["123-45", "678-90", "111-22"]


def test_trailing_unit_suffix_kept_then_dropped():
    groups = split_accounts("123456/0")
    assert len(groups) == 1
    assert groups[0].display == "123456/0"
    assert "123456" in groups[0].candidates  # try with, then without


def test_leading_zeros():
    variants = candidate_variants("00123-04")
    assert variants[0] == "00123-04"
    assert "12304" in variants  # no separators, no leading zeros


def test_empty_and_placeholder_cells():
    assert split_accounts(None) == []
    assert split_accounts("  ") == []
    assert split_accounts("N/A") == []


def test_account_matches_ignores_format():
    cands = candidate_variants("#04-2209-AB-0120")
    assert account_matches(cands, "042209ab0120")
    assert account_matches(cands, "04 2209 AB 0120")
    assert not account_matches(cands, "999999")
