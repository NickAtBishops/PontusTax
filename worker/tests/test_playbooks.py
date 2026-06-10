from pontus_tax.playbooks import SEED_PLAYBOOKS, draft_playbook, match_playbook
from pontus_tax.taxonomy import TYPE_A, TYPE_B, TYPE_D, classify_url, domain_of


def test_vendor_matching_by_url():
    lib = list(SEED_PLAYBOOKS)
    assert match_playbook("https://pinellas.county-taxes.net/public", lib).key == "grant_street"
    assert match_playbook(
        "https://pbctax.publicaccessnow.com/PropertyTax/Account.aspx?p=1&a=2", lib
    ).key == "publicaccessnow"
    assert match_playbook("https://taxes.example.org/ptaxweb/editPropertySearch2.action", lib).key == "ptaxweb_pacific_blue"
    assert match_playbook("https://unknown-county.gov/tax", lib) is None


def test_vendor_matching_by_footer():
    lib = list(SEED_PLAYBOOKS)
    pb = match_playbook("https://unknown.gov/", lib, vendor_footer="Powered by Grant Street Group")
    assert pb is not None and pb.key == "grant_street"


def test_draft_playbook_grows_library():
    pb = draft_playbook(
        "Powered by NewVendor Civic", "https://tax.newvendor.com/search",
        TYPE_B, "search portal with per-year billing tab",
    )
    assert pb.key == "powered_by_newvendor_civic"
    assert pb.source == "discovered"
    assert "tax.newvendor.com" in pb.url_patterns


def test_url_taxonomy_classification():
    lib = list(SEED_PLAYBOOKS)
    deep = "https://pbctax.publicaccessnow.com/PropertyTax/Account.aspx?p=74-43&a=1418360"
    assert classify_url(deep, match_playbook(deep, lib)) == TYPE_A
    pinned = "https://stjohns.county-taxes.net/public/search?y=2025"
    assert classify_url(pinned, match_playbook(pinned, lib)) == TYPE_D
    bare = "https://broward.county-taxes.com/public"
    assert classify_url(bare, match_playbook(bare, lib)) in (TYPE_A, TYPE_B)
    assert classify_url(None, None) == TYPE_B
    assert domain_of(deep) == "pbctax.publicaccessnow.com"
