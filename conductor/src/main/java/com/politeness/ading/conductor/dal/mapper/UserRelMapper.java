package com.politeness.ading.conductor.dal.mapper;

import com.politeness.ading.conductor.dal.entity.UserRelEntity;
import java.util.List;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface UserRelMapper {

    /** Idempotent: creating an existing friend relation again does not error */
    @Insert("""
            INSERT INTO users_rel (user_id, friend_id, status)
            VALUES (#{userId}, #{friendId}, #{status})
            ON DUPLICATE KEY UPDATE status = VALUES(status)
            """)
    int upsert(UserRelEntity rel);

    /**
     * Deletes the friend relation and requests in both directions; does nothing if none exist.
     * Block records are not deleted: when the blocked side removes the friend, it must not also remove the other side's block
     */
    @Delete("""
            DELETE FROM users_rel
             WHERE ((user_id = #{userId} AND friend_id = #{friendId})
                OR (user_id = #{friendId} AND friend_id = #{userId}))
               AND status <> 'BLOCKED'
            """)
    int deletePair(@Param("userId") String userId, @Param("friendId") String friendId);

    @Select("""
            SELECT friend_id FROM users_rel
             WHERE user_id = #{userId} AND status = 'ACCEPTED'
             ORDER BY id
            """)
    List<String> listFriendIds(@Param("userId") String userId);

    @Select("SELECT friend_id FROM users_rel WHERE user_id = #{userId} AND status = 'SHARED'")
    List<String> listSharedAgentIds(@Param("userId") String userId);

    @Select("SELECT user_id FROM users_rel WHERE friend_id = #{agentId} AND status = 'SHARED'")
    List<String> listAgentRecipients(@Param("agentId") String agentId);

    @Delete("DELETE FROM users_rel WHERE user_id = #{userId} AND friend_id = #{agentId} AND status = 'SHARED'")
    int revokeAgent(@Param("userId") String userId, @Param("agentId") String agentId);

    @Delete("""
            DELETE r FROM users_rel r JOIN users a ON a.user_id = r.friend_id AND a.is_agent = 1
             WHERE r.status = 'SHARED'
               AND ((r.user_id = #{userId} AND a.owner = #{friendId})
                 OR (r.user_id = #{friendId} AND a.owner = #{userId}))
            """)
    int revokeSharesBetween(@Param("userId") String userId, @Param("friendId") String friendId);

    @Select("""
            SELECT DISTINCT r.user_id FROM users_rel r
              JOIN users a ON a.user_id = r.friend_id AND a.is_agent = 1 AND a.owner = #{owner}
              JOIN users_rel f ON f.user_id = r.user_id AND f.friend_id = a.owner AND f.status = 'ACCEPTED'
             WHERE r.status = 'SHARED'
            """)
    List<String> listOwnerShareRecipients(@Param("owner") String owner);

    /** The relation in one direction; empty if none */
    @Select("SELECT * FROM users_rel WHERE user_id = #{userId} AND friend_id = #{friendId}")
    UserRelEntity find(@Param("userId") String userId, @Param("friendId") String friendId);

    /** Deletes a pending request in one direction; existing friendships are left alone */
    @Delete("""
            DELETE FROM users_rel
             WHERE user_id = #{userId} AND friend_id = #{friendId} AND status = 'PENDING'
            """)
    int deletePending(@Param("userId") String userId, @Param("friendId") String friendId);

    /** Unhandled requests others sent me, newest first */
    @Select("""
            SELECT * FROM users_rel
             WHERE friend_id = #{userId} AND status = 'PENDING'
             ORDER BY id DESC
            """)
    List<UserRelEntity> listIncoming(@Param("userId") String userId);

    /** Requests I sent that the other side has not handled yet, newest first */
    @Select("""
            SELECT * FROM users_rel
             WHERE user_id = #{userId} AND status = 'PENDING'
             ORDER BY id DESC
            """)
    List<UserRelEntity> listOutgoing(@Param("userId") String userId);

    @Select("""
            SELECT COUNT(1) FROM users_rel
             WHERE user_id = #{userId} AND friend_id = #{friendId} AND status = 'ACCEPTED'
            """)
    int countAccepted(@Param("userId") String userId, @Param("friendId") String friendId);

    /** Unblock someone; does nothing if they were not blocked */
    @Delete("""
            DELETE FROM users_rel
             WHERE user_id = #{userId} AND friend_id = #{friendId} AND status = 'BLOCKED'
            """)
    int deleteBlocked(@Param("userId") String userId, @Param("friendId") String friendId);

    /** People I blocked, most recently blocked first */
    @Select("""
            SELECT friend_id FROM users_rel
             WHERE user_id = #{userId} AND status = 'BLOCKED'
             ORDER BY id DESC
            """)
    List<String> listBlockedIds(@Param("userId") String userId);
}
