package com.politeness.ading.ops.dal.mapper;

import com.politeness.ading.ops.dal.OpsAccountRow;
import com.politeness.ading.ops.dal.OpsUserRow;
import java.time.LocalDateTime;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/**
 * This Mapper is read-only on users and user_tags; tag add/remove is in UserTagMapper, password changes and disabling are still done in ADing itself.
 */
@Mapper
public interface OpsUserMapper {

    /** For login checks. Includes the password hash and token epoch; these two columns never appear in any response */
    @Select("""
            SELECT user_id, username, display_name, is_agent, status, password,
                   token_epoch, gmt_created AS registered_at
              FROM users
             WHERE username = #{username}
            """)
    OpsAccountRow findAccountByUsername(@Param("username") String username);

    /**
     * For session re-checks: every request checks the token epoch and account status; a password change or disabling invalidates it on the spot.
     * Deliberately doesn't select password - the interceptor path doesn't need it, and the hash shouldn't be pulled into memory.
     */
    @Select("""
            SELECT user_id, username, display_name, status, token_epoch
              FROM users
             WHERE user_id = #{userId} AND is_agent = 0
            """)
    OpsAccountRow findSessionAccount(@Param("userId") String userId);

    @Select("SELECT COUNT(*) FROM users u WHERE u.is_agent = 0 AND " + StatisticsScope.USER_U)
    long countRealUsers();

    @Select("""
            <script>
            SELECT * FROM (
            SELECT u.user_id, u.username, u.display_name, u.phone, u.email, u.status,
                   u.gmt_created AS registered_at,
                   (SELECT COUNT(*) FROM terminals t WHERE """ + StatisticsScope.TERMINAL_T + """
                 AND t.owner = u.user_id) AS terminal_count,
                   (SELECT COUNT(*) FROM users a
                      JOIN users_rel r ON r.user_id = a.owner AND r.friend_id = a.user_id AND r.status = 'ACCEPTED'
                     WHERE a.owner = u.user_id AND a.is_agent = 1) AS agent_count,
                   (SELECT COUNT(*) FROM terminals t WHERE """ + StatisticsScope.TERMINAL_T + """
                 AND t.owner = u.user_id
                       AND (EXISTS (SELECT 1 FROM """ + StatisticsScope.ACTIVITY + """
                                  h
                                     WHERE h.device_uuid = t.fingerprint AND h.user_id = t.owner AND h.ended_at >= #{activeSince}))) AS active_terminal_count,
                   (SELECT MAX(h.ended_at) FROM """ + StatisticsScope.ACTIVITY + """
                                  h WHERE """ + StatisticsScope.HOUR_H + """
                 AND h.user_id = u.user_id) AS last_report_at,
                   (SELECT MAX(h.ended_at) FROM """ + StatisticsScope.ACTIVITY + """
                                  h WHERE """ + StatisticsScope.HOUR_H + """
                 AND h.user_id = u.user_id) AS last_seen_at,
                   """ + OnlinePresence.USER + """
                   AS online,
                   (SELECT GROUP_CONCAT(ut.tag ORDER BY ut.id SEPARATOR ',') FROM user_tags ut WHERE ut.user_id = u.user_id) AS tags
              FROM users u
             WHERE u.is_agent = 0 AND """ + StatisticsScope.USER_U + """
            <if test="keyword != null">
               AND (u.username LIKE #{keyword} ESCAPE '\\\\'
                 OR u.display_name LIKE #{keyword} ESCAPE '\\\\'
                 OR u.phone LIKE #{keyword} ESCAPE '\\\\'
                 OR u.email LIKE #{keyword} ESCAPE '\\\\'
                 OR u.user_id LIKE #{keyword} ESCAPE '\\\\')
            </if>
            ) user_activity
             ORDER BY online DESC, CASE WHEN last_report_at IS NULL THEN last_seen_at
                           WHEN last_seen_at IS NULL THEN last_report_at
                           WHEN last_report_at > last_seen_at THEN last_report_at ELSE last_seen_at END DESC,
                      user_id ASC
             LIMIT #{size} OFFSET #{offset}
            </script>
            """)
    List<OpsUserRow> searchUsers(@Param("keyword") String keyword,
                                 @Param("activeSince") LocalDateTime activeSince,
                                 @Param("onlineSince") LocalDateTime onlineSince,
                                 @Param("offset") int offset,
                                 @Param("size") int size);

    @Select("""
            <script>
            SELECT COUNT(*)
              FROM users u
             WHERE u.is_agent = 0 AND """ + StatisticsScope.USER_U + """
            <if test="keyword != null">
               AND (u.username LIKE #{keyword} ESCAPE '\\\\'
                 OR u.display_name LIKE #{keyword} ESCAPE '\\\\'
                 OR u.phone LIKE #{keyword} ESCAPE '\\\\'
                 OR u.email LIKE #{keyword} ESCAPE '\\\\'
                 OR u.user_id LIKE #{keyword} ESCAPE '\\\\')
            </if>
            </script>
            """)
    long countUsers(@Param("keyword") String keyword);
    @Select("""
            <script>
            SELECT u.user_id, u.username, u.display_name, u.status, u.gmt_created AS registered_at,
                   u.owner, u.agent_type, o.display_name AS owner_name,
                   EXISTS (SELECT 1 FROM users_rel r WHERE r.user_id = u.owner AND r.friend_id = u.user_id AND r.status = 'ACCEPTED') AS contact
              FROM users u LEFT JOIN users o ON o.user_id = u.owner WHERE u.is_agent = 1 AND """ + StatisticsScope.AGENT_U + """
            <if test="keyword != null">
               AND (u.username LIKE #{keyword} ESCAPE '\\\\' OR u.display_name LIKE #{keyword} ESCAPE '\\\\')
            </if>
            <if test="owner != null"> AND u.owner = #{owner} </if>
            <if test="contactOnly"> AND EXISTS (SELECT 1 FROM users_rel r WHERE r.user_id = u.owner AND r.friend_id = u.user_id AND r.status = 'ACCEPTED') </if>
             ORDER BY u.id DESC LIMIT #{size} OFFSET #{offset}
            </script>
            """)
    List<com.politeness.ading.ops.dal.OpsAgentRow> searchAgents(@Param("keyword") String keyword, @Param("owner") String owner, @Param("contactOnly") boolean contactOnly, @Param("offset") int offset, @Param("size") int size);

    @Select("""
            <script>
            SELECT COUNT(*) FROM users u WHERE u.is_agent = 1 AND """ + StatisticsScope.AGENT_U + """
            <if test="keyword != null">
               AND (u.username LIKE #{keyword} ESCAPE '\\\\' OR u.display_name LIKE #{keyword} ESCAPE '\\\\')
            </if>
            <if test="owner != null"> AND u.owner = #{owner} </if>
            <if test="contactOnly"> AND EXISTS (SELECT 1 FROM users_rel r WHERE r.user_id = u.owner AND r.friend_id = u.user_id AND r.status = 'ACCEPTED') </if>
            </script>
            """)
    long countAgentRows(@Param("keyword") String keyword, @Param("owner") String owner, @Param("contactOnly") boolean contactOnly);
}
