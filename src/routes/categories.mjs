import { Router } from "express";

/**
 * Category-related API endpoints for the insight-bff service
 * Handles category navigation and article retrieval by category
 */

export function createCategoryRoutes(
  supabase,
  { withTimeout, langMiddleware, setLangHeaders, dirFor }
) {
  const router = Router();

  // GET /categories/navigation - Main navigation categories with counts
  router.get("/navigation", langMiddleware, async (req, res) => {
    const target = req.lang;

    try {
      // Get main navigation categories with article counts
      const { data: categories, error } = await withTimeout(
        supabase
          .from("categories")
          .select(
            `
            id,
            name,
            slug,
            display_order,
            is_main_nav,
            icon_emoji,
            color_hex,
            article_categories!inner(count)
          `
          )
          .eq("is_main_nav", true)
          .order("display_order", { ascending: true }),
        3000,
        "categories navigation"
      );

      if (error) throw error;

      // Transform to include article counts
      const navCategories = (categories || []).map((cat) => ({
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        icon_emoji: cat.icon_emoji || "📰",
        color_hex: cat.color_hex || "#6B7280",
        display_order: cat.display_order || 99,
        article_count: cat.article_categories?.length || 0,
      }));

      res.json({
        categories: navCategories,
        language: target,
      });
    } catch (error) {
      console.error("[Categories Navigation] Error:", error);
      res.status(500).json({ error: "Failed to load navigation categories" });
    }
  });

  // GET /categories - All categories with counts and hierarchy
  router.get("/", langMiddleware, async (req, res) => {
    const target = req.lang;
    const mainNavOnly = req.query.main_nav === "true";

    try {
      let query = supabase
        .from("categories")
        .select(
          `
          id,
          name,
          slug,
          parent_id,
          display_order,
          is_main_nav,
          icon_emoji,
          color_hex
        `
        )
        .order("display_order", { ascending: true })
        .order("name", { ascending: true });

      if (mainNavOnly) {
        query = query.eq("is_main_nav", true);
      }

      const { data: categories, error } = await withTimeout(
        query,
        3000,
        "categories all"
      );

      if (error) throw error;

      // Get article counts for each category
      const categoryIds = (categories || []).map((cat) => cat.id);
      let categoryCounts = new Map();

      if (categoryIds.length > 0) {
        const { data: counts, error: countError } = await withTimeout(
          supabase
            .from("article_categories")
            .select("category_id")
            .in("category_id", categoryIds),
          2000,
          "category counts"
        );

        if (!countError && counts) {
          const countMap = counts.reduce((acc, item) => {
            acc[item.category_id] = (acc[item.category_id] || 0) + 1;
            return acc;
          }, {});
          categoryCounts = new Map(
            Object.entries(countMap).map(([k, v]) => [parseInt(k), v])
          );
        }
      }

      // Transform categories with counts and hierarchy
      const transformedCategories = (categories || []).map((cat) => ({
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        parent_id: cat.parent_id,
        display_order: cat.display_order || 99,
        is_main_nav: cat.is_main_nav || false,
        icon_emoji: cat.icon_emoji || "📰",
        color_hex: cat.color_hex || "#6B7280",
        article_count: categoryCounts.get(cat.id) || 0,
      }));

      // Organize into hierarchy (primary categories with their subcategories)
      const primaryCategories = transformedCategories.filter(
        (cat) => !cat.parent_id
      );
      const subcategories = transformedCategories.filter(
        (cat) => cat.parent_id
      );

      const hierarchicalCategories = primaryCategories.map((primary) => ({
        ...primary,
        subcategories: subcategories
          .filter((sub) => sub.parent_id === primary.id)
          .sort(
            (a, b) =>
              a.display_order - b.display_order || a.name.localeCompare(b.name)
          ),
      }));

      res.json({
        categories: hierarchicalCategories,
        total_categories: transformedCategories.length,
        main_nav_count: transformedCategories.filter((cat) => cat.is_main_nav)
          .length,
        language: target,
      });
    } catch (error) {
      console.error("[Categories All] Error:", error);
      res.status(500).json({ error: "Failed to load categories" });
    }
  });

  // GET /categories/:slug/articles - Articles for a specific category
  router.get("/:slug/articles", langMiddleware, async (req, res) => {
    const { slug } = req.params;
    const target = req.lang;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    try {
      // First, find the category by slug
      const { data: category, error: catError } = await withTimeout(
        supabase
          .from("categories")
          .select("id, name, slug")
          .eq("slug", slug)
          .single(),
        2000,
        "category lookup"
      );

      if (catError || !category) {
        return res.status(404).json({ error: "Category not found" });
      }

      // Get articles for this category
      const { data: articleLinks, error: linkError } = await withTimeout(
        supabase
          .from("article_categories")
          .select("article_id")
          .eq("category_id", category.id),
        3000,
        "category articles links"
      );

      if (linkError) throw linkError;

      const articleIds = (articleLinks || []).map((link) => link.article_id);

      if (articleIds.length === 0) {
        return res.json({
          category: {
            id: category.id,
            name: category.name,
            slug: category.slug,
          },
          articles: [],
          pagination: {
            total: 0,
            limit,
            offset,
            has_more: false,
          },
          language: target,
        });
      }

      // Get paginated articles with basic info
      const { data: articles, error: articlesError } = await withTimeout(
        supabase
          .from("articles")
          .select(
            `
            id,
            title,
            snippet,
            published_at,
            image_url,
            url,
            canonical_url,
            source_id,
            lang
          `
          )
          .in("id", articleIds)
          .order("published_at", { ascending: false })
          .range(offset, offset + limit - 1),
        3000,
        "articles data"
      );

      if (articlesError) throw articlesError;

      // Get source names for the articles
      const sourceIds = [
        ...new Set((articles || []).map((a) => a.source_id).filter(Boolean)),
      ];
      let sourceMap = new Map();

      if (sourceIds.length > 0) {
        const { data: sources } = await withTimeout(
          supabase.from("sources").select("id, name").in("id", sourceIds),
          2000,
          "sources data"
        );
        sourceMap = new Map((sources || []).map((s) => [s.id, s.name]));
      }

      // Get translations for articles (preferring target language)
      const articleIdList = (articles || []).map((a) => a.id);
      let translationMap = new Map();

      if (articleIdList.length > 0) {
        // Try to get translations in target language first
        const { data: translations } = await withTimeout(
          supabase
            .from("articles_translations")
            .select("article_id, dst_lang, headline, summary_ai")
            .in("article_id", articleIdList)
            .eq("dst_lang", target),
          2000,
          "article translations"
        );

        translationMap = new Map(
          (translations || []).map((t) => [t.article_id, t])
        );

        // For articles without target language translation, get any available translation
        const missingTranslations = articleIdList.filter(
          (id) => !translationMap.has(id)
        );
        if (missingTranslations.length > 0) {
          const { data: fallbackTranslations } = await withTimeout(
            supabase
              .from("articles_translations")
              .select("article_id, dst_lang, headline, summary_ai")
              .in("article_id", missingTranslations)
              .limit(missingTranslations.length),
            2000,
            "fallback translations"
          );

          (fallbackTranslations || []).forEach((t) => {
            if (!translationMap.has(t.article_id)) {
              translationMap.set(t.article_id, t);
            }
          });
        }
      }

      // Transform articles with translations and source info
      const transformedArticles = (articles || []).map((article) => {
        const translation = translationMap.get(article.id);
        const sourceName = sourceMap.get(article.source_id);

        const base = (lang) => (lang || "").split("-")[0].toLowerCase();
        const isTranslated =
          translation &&
          article.lang &&
          base(translation.dst_lang) !== base(article.lang);

        return {
          id: article.id,
          title: translation?.headline || article.title || "",
          summary: translation?.summary_ai || article.snippet || "",
          published_at: article.published_at,
          url: article.canonical_url || article.url,
          image_url: article.image_url,
          source_name: sourceName || "Unknown Source",
          language: translation?.dst_lang || target,
          is_translated: isTranslated,
          translated_from: isTranslated ? article.lang : null,
          dir: dirFor(translation?.dst_lang || target),
        };
      });

      const totalCount = articleIds.length;

      res.json({
        category: {
          id: category.id,
          name: category.name,
          slug: category.slug,
        },
        articles: transformedArticles,
        pagination: {
          total: totalCount,
          limit,
          offset,
          has_more: offset + limit < totalCount,
        },
        language: target,
      });
    } catch (error) {
      console.error(`[Category Articles] Error for slug=${slug}:`, error);
      res.status(500).json({ error: "Failed to load category articles" });
    }
  });

  return router;
}

export default createCategoryRoutes;
